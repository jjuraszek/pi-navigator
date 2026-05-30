import test from "node:test";
import assert from "node:assert/strict";
import { hashBuffer, isBinary } from "./hash.ts";

test("hashBuffer is stable sha-256 hex", () => {
  assert.equal(hashBuffer(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("isBinary returns false for text, true when null byte present", () => {
  assert.equal(isBinary(Buffer.from("hello")), false);
  assert.equal(isBinary(Buffer.from([104, 0, 105])), true);
});
