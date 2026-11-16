import { createHash } from "node:crypto";
import { createServer } from "node:http";

function buildEmbedding(text, dimensions) {
  // Independent signed coordinates avoid periodic, nearly parallel F16 vectors.
  let block = createHash("sha256").update(text).digest();
  const vector = [];
  for (let i = 0; i < dimensions; i += 1) {
    const offset = (i % 8) * 4;
    if (i > 0 && offset === 0) block = createHash("sha256").update(block).digest();
    vector.push(block.readInt32LE(offset) / 0x80000000);
  }
  return vector;
}

const port = Number(process.env.EVAL_EMBED_PORT ?? "11434");
const dimensions = Number(process.env.EVAL_EMBED_DIMS ?? "8");

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/embeddings") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const rawInput = parsed.input;
        const inputs = Array.isArray(rawInput)
          ? rawInput.map((item) => String(item))
          : [String(rawInput ?? "")];

        const data = inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: buildEmbedding(input, dimensions),
        }));

        const tokens = inputs.reduce((sum, input) => sum + Math.max(1, Math.ceil(input.length / 4)), 0);
        const payload = JSON.stringify({
          object: "list",
          data,
          model: "mock-embedding-model",
          usage: {
            total_tokens: tokens,
          },
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
      } catch (error) {
        console.error("[mock-embeddings] Request error:", error);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[eval-mock-embeddings] listening on http://127.0.0.1:${server.address().port}/v1/embeddings`);
});
