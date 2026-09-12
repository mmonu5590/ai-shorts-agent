import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { StaticTokenAuthenticator, parseTokenList } from "../tokens.ts";
import { AuthConfigError } from "../types.ts";

const TOKEN = "a-sufficiently-long-token";

function requestWith(authorization?: string): IncomingMessage {
  return { headers: authorization === undefined ? {} : { authorization } } as IncomingMessage;
}

function authenticator(tokens: [string, string][] = [[TOKEN, "alice"]]) {
  return new StaticTokenAuthenticator({ tokens: new Map(tokens) });
}

describe("parseTokenList", () => {
  it("parses principal:token pairs", () => {
    const tokens = parseTokenList(" alice:tok-one , bob:tok-two ");
    assert.equal(tokens.get("tok-one"), "alice");
    assert.equal(tokens.get("tok-two"), "bob");
  });

  it("keeps colons inside the token", () => {
    assert.equal(parseTokenList("alice:a:b:c").get("a:b:c"), "alice");
  });

  it("rejects malformed entries instead of dropping them silently", () => {
    // A dropped entry is an account that stops working with no explanation.
    for (const bad of ["alice", ":token", "alice:", "alice:tok,broken"]) {
      assert.throws(() => parseTokenList(bad), AuthConfigError, `should reject ${bad}`);
    }
  });

  it("rejects a token shared by two principals", () => {
    assert.throws(() => parseTokenList("alice:same,bob:same"), AuthConfigError);
  });
});

describe("StaticTokenAuthenticator", () => {
  it("refuses to start with no tokens", () => {
    assert.throws(() => new StaticTokenAuthenticator({ tokens: new Map() }), AuthConfigError);
  });

  it("refuses a token short enough to guess", () => {
    assert.throws(() => authenticator([["short", "alice"]]), AuthConfigError);
  });

  it("refuses a principal id that could reshape a storage prefix", () => {
    assert.throws(() => authenticator([[TOKEN, "../etc"]]), AuthConfigError);
  });

  it("resolves the principal for a valid bearer token", async () => {
    assert.deepEqual(await authenticator().authenticate(requestWith(`Bearer ${TOKEN}`)), {
      id: "alice",
    });
  });

  it("returns null for a missing, malformed, or wrong credential", async () => {
    const auth = authenticator();
    for (const header of [
      undefined,
      "",
      TOKEN,
      `Basic ${TOKEN}`,
      "Bearer",
      "Bearer wrong-but-long-enough-token",
    ]) {
      assert.equal(await auth.authenticate(requestWith(header)), null, `should reject ${header}`);
    }
  });

  it("tells two principals apart", async () => {
    const auth = authenticator([
      [TOKEN, "alice"],
      ["another-sufficiently-long-token", "bob"],
    ]);

    assert.deepEqual(await auth.authenticate(requestWith(`Bearer ${TOKEN}`)), { id: "alice" });
    assert.deepEqual(
      await auth.authenticate(requestWith("Bearer another-sufficiently-long-token")),
      { id: "bob" },
    );
  });

  it("tolerates surrounding whitespace in the header", async () => {
    assert.deepEqual(await authenticator().authenticate(requestWith(`  Bearer ${TOKEN}  `)), {
      id: "alice",
    });
  });
});
