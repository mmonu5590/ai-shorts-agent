import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StorageError, normalizeKey, splitKey } from "../types.ts";

describe("key validation", () => {
  it("splits a well-formed key", () => {
    assert.deepEqual(splitKey("jobs/abc/source.mp4"), ["jobs", "abc", "source.mp4"]);
  });

  it("collapses redundant slashes", () => {
    assert.equal(normalizeKey("jobs//abc///source.mp4"), "jobs/abc/source.mp4");
    assert.equal(normalizeKey("jobs/abc/"), "jobs/abc");
  });

  for (const bad of ["", "/jobs/abc", "../etc/passwd", "jobs/../../etc/passwd", "jobs/./abc", "jobs\\abc"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => splitKey(bad), StorageError);
    });
  }
});
