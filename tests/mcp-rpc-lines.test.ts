import { PassThrough } from "node:stream";
import { RpcLines } from "../src/adapters/mcp/rpc-lines.js";

it("bounds an unterminated frame before parsing JSON", () => {
  const source = new PassThrough();
  const error = vi.fn();
  const line = vi.fn();
  new RpcLines(source, 32, line, error, vi.fn());
  source.write("x".repeat(33));
  expect(error).toHaveBeenCalledOnce();
  expect(line).not.toHaveBeenCalled();
});

it("pauses within a chunk and resumes buffered frames for a slow downstream reader", () => {
  const source = new PassThrough();
  const lines: string[] = [];
  const reader = new RpcLines(source, 32, (line) => {
    lines.push(line);
    reader.pause();
  }, () => { throw new Error("Unexpected framing error"); }, vi.fn());
  source.write("first\nsecond\nthird\n");
  expect(lines).toEqual(["first"]);
  expect(source.isPaused()).toBe(true);
  reader.resume();
  expect(lines).toEqual(["first", "second"]);
  reader.resume();
  expect(lines).toEqual(["first", "second", "third"]);
  reader.close();
});
