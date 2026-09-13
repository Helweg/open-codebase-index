import type { Readable } from "node:stream";

/** Bound framing before JSON parsing, including peers which never send a newline. */
export class RpcLines {
  private buffer = Buffer.alloc(0);
  private paused = false;
  private ended = false;

  constructor(
    private readonly stream: Readable,
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onError: () => void,
    onEnd: () => void,
  ) {
    stream.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    stream.once("end", () => {
      this.ended = true;
      if (this.buffer.length > 0) this.onError();
      onEnd();
    });
    stream.once("error", onError);
  }

  private pump(): void {
    while (!this.paused && !this.ended) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > this.maxBytes) this.reject();
        return;
      }
      if (newline > this.maxBytes) { this.reject(); return; }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private reject(): void {
    this.close();
    this.onError();
  }

  pause(): void {
    this.paused = true;
    this.stream.pause();
  }

  resume(): void {
    if (this.ended) return;
    this.paused = false;
    this.pump();
    if (!this.paused) this.stream.resume();
  }

  close(): void {
    this.ended = true;
    this.buffer = Buffer.alloc(0);
    this.stream.pause();
  }
}
