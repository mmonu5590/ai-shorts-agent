import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AuthConfigError, createAuthenticator, isLoopbackHost } from "../index.ts";

const saved = { AUTH: process.env["AUTH"], API_TOKENS: process.env["API_TOKENS"] };

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isLoopbackHost", () => {
  it("recognises the local-only addresses", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
  });

  it("treats everything else as reachable", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "example.com"]) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});

describe("createAuthenticator", () => {
  it("allows anonymous access on loopback, for local development", () => {
    delete process.env["AUTH"];
    assert.equal(createAuthenticator("127.0.0.1").name, "none");
  });

  it("refuses to serve unauthenticated on a reachable address", () => {
    // The whole point: an open deployment must be chosen, not inherited.
    delete process.env["AUTH"];
    assert.throws(() => createAuthenticator("0.0.0.0"), AuthConfigError);
    assert.throws(() => createAuthenticator("0.0.0.0"), /every uploaded video/u);
  });

  it("builds a token authenticator, which is allowed on any address", () => {
    process.env["AUTH"] = "token";
    process.env["API_TOKENS"] = "alice:a-sufficiently-long-token";

    assert.equal(createAuthenticator("0.0.0.0").name, "token");
  });

  it("refuses AUTH=token with no tokens configured", () => {
    process.env["AUTH"] = "token";
    delete process.env["API_TOKENS"];

    assert.throws(() => createAuthenticator("127.0.0.1"), AuthConfigError);
  });

  it("rejects an unknown mode rather than falling back to something permissive", () => {
    process.env["AUTH"] = "basic";
    assert.throws(() => createAuthenticator("127.0.0.1"), AuthConfigError);
  });
});
