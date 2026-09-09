import { createHash } from "node:crypto";

export interface PdfFixturePage {
  lines?: string[];
  empty?: boolean;
}

function serializePdf(objects: string[], trailer = ""): Uint8Array {
  let text = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(text, "latin1"));
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text, "latin1");
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(text, "latin1"));
}

function pdfString(value: string): string {
  if (/[^\x20-\x7e]/u.test(value)) throw new Error("Fixture text must be printable ASCII.");
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

export function buildPdfFixture(pages: PdfFixturePage[]): Uint8Array {
  if (pages.length === 0) throw new Error("At least one fixture page is required.");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, page] of pages.entries()) {
    const stream = page.empty ? "" : `BT /F1 12 Tf 16 TL 72 720 Td ${(page.lines ?? [])
      .map((line, i) => `${i ? "T* " : ""}(${pdfString(line)}) Tj`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  return serializePdf(objects);
}

// PDF 1.4 revision-2 security algorithm, used ONLY to generate a deterministic
// password-protected blank test document. This is not production cryptography.
const PASSWORD_PADDING = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
function paddedPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, "ascii"), PASSWORD_PADDING]).subarray(0, 32);
}
function md5(bytes: Uint8Array): Buffer {
  return createHash("md5").update(bytes).digest();
}
function rc4(key: Uint8Array, input: Uint8Array): Buffer {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(input.map((byte) => {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    return byte ^ state[(state[i] + state[j]) & 255];
  }));
}

export function buildEncryptedPdfFixture(): Uint8Array {
  const id = Buffer.alloc(16, 7);
  const owner = rc4(md5(paddedPassword("owner")).subarray(0, 5), paddedPassword("secret"));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([paddedPassword("secret"), owner, permissions, id])).subarray(0, 5);
  const user = rc4(key, PASSWORD_PADDING);
  // No content streams or PDF strings need encryption in this blank document.
  return serializePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
  ], `/Encrypt 4 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`);
}

export function buildMalformedPdfFixture(): Uint8Array {
  return new TextEncoder().encode("not-a-pdf");
}
