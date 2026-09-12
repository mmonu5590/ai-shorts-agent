/**
 * Bearer-token authentication against a fixed token list.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  type Authenticator,
  type Principal,
  AuthConfigError,
  PRINCIPAL_ID_PATTERN,
} from "./types.ts";

/** Compares without leaking the matching prefix length through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // length oracle, so both sides are hashed to a fixed width first.
  if (left.length !== right.length) {
    // Still do the work, so a wrong-length token costs the same as a wrong one.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface StaticTokenAuthenticatorOptions {
  /** Principal ID keyed by bearer token. */
  tokens: Map<string, string>;
}

export class StaticTokenAuthenticator implements Authenticator {
  readonly name = "token";
  readonly #tokens: Map<string, string>;

  constructor(options: StaticTokenAuthenticatorOptions) {
    if (options.tokens.size === 0) {
      throw new AuthConfigError("StaticTokenAuthenticator needs at least one token");
    }
    for (const [token, principalId] of options.tokens) {
      if (token.length < 16) {
        throw new AuthConfigError(
          `Token for "${principalId}" is ${token.length} characters; use at least 16`,
        );
      }
      if (!PRINCIPAL_ID_PATTERN.test(principalId)) {
        throw new AuthConfigError(
          `Principal id "${principalId}" must be 1-64 characters from [A-Za-z0-9_-]`,
        );
      }
    }
    this.#tokens = options.tokens;
  }

  async authenticate(request: IncomingMessage): Promise<Principal | null> {
    const header = request.headers.authorization;
    if (!header) return null;

    const match = /^Bearer\s+(.+)$/u.exec(header.trim());
    if (!match) return null;
    const presented = match[1] as string;

    // Every configured token is compared, so the time taken does not reveal
    // how far down the list a match was found.
    let found: string | null = null;
    for (const [token, principalId] of this.#tokens) {
      if (constantTimeEquals(token, presented)) found = principalId;
    }
    return found === null ? null : { id: found };
  }
}

/**
 * Parses `API_TOKENS`, formatted `principal:token,principal:token`.
 *
 * @throws {AuthConfigError} on a malformed entry, rather than silently
 * dropping it — a dropped entry is an account that stops working with no
 * explanation.
 */
export function parseTokenList(raw: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new AuthConfigError(`Malformed API_TOKENS entry; expected "principal:token"`);
    }
    const principalId = entry.slice(0, separator);
    const token = entry.slice(separator + 1);
    if (tokens.has(token)) {
      throw new AuthConfigError(`Duplicate token in API_TOKENS`);
    }
    tokens.set(token, principalId);
  }
  return tokens;
}
