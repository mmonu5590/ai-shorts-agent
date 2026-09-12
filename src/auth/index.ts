/**
 * Authenticator wiring.
 */

import { StaticTokenAuthenticator, parseTokenList } from "./tokens.ts";
import { type Authenticator, AnonymousAuthenticator, AuthConfigError } from "./types.ts";

export * from "./types.ts";
export { StaticTokenAuthenticator, parseTokenList } from "./tokens.ts";

/** True for addresses that only the local machine can reach. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Builds the authenticator from `AUTH`.
 *
 * `token` requires `API_TOKENS`. `none` authenticates nobody and is refused on
 * a non-loopback bind: serving other people's video to an unauthenticated
 * network is not something to arrive at by leaving a variable unset.
 */
export function createAuthenticator(host: string): Authenticator {
  const mode = process.env["AUTH"] ?? "none";

  switch (mode) {
    case "token": {
      const raw = process.env["API_TOKENS"];
      if (!raw) {
        throw new AuthConfigError('AUTH=token requires API_TOKENS ("principal:token,...")');
      }
      return new StaticTokenAuthenticator({ tokens: parseTokenList(raw) });
    }
    case "none": {
      if (!isLoopbackHost(host)) {
        throw new AuthConfigError(
          `Refusing to serve unauthenticated on ${host}. Anyone who can reach this port ` +
            `could read every uploaded video. Set AUTH=token with API_TOKENS, or bind to ` +
            `127.0.0.1 for local development.`,
        );
      }
      return new AnonymousAuthenticator();
    }
    default:
      throw new AuthConfigError(`Unknown AUTH "${mode}" (expected "token" or "none")`);
  }
}
