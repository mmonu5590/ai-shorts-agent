/**
 * Who is making a request.
 *
 * The pipeline stores people's video and their speech. Until something
 * identifies the caller, every job is readable by anyone who can reach the
 * port — so this is the seam that identifies them.
 *
 * {@link StaticTokenAuthenticator} is a real implementation, not a placeholder,
 * but it is not a user system: a Supabase or OIDC authenticator implements the
 * same interface and nothing downstream changes.
 */

import type { IncomingMessage } from "node:http";

export interface Principal {
  /** Stable identifier. Becomes the job owner, so it must be a safe key segment. */
  id: string;
}

export interface Authenticator {
  readonly name: string;
  /** Resolves the caller, or null when the request carries no valid credential. */
  authenticate(request: IncomingMessage): Promise<Principal | null>;
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Principal IDs name storage prefixes, so they are constrained like job IDs. */
export const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Grants every request the same identity.
 *
 * For local development only. It is never the default — reaching it requires
 * setting `AUTH=none`, so an unauthenticated deployment is always something
 * someone chose rather than something they inherited.
 */
export class AnonymousAuthenticator implements Authenticator {
  readonly name = "none";
  readonly #principal: Principal;

  constructor(id = "anonymous") {
    this.#principal = { id };
  }

  async authenticate(): Promise<Principal> {
    return this.#principal;
  }
}
