# Authentication

The pipeline stores people's video and their speech. Before this existed, every
job was readable by anyone who could reach the port, and `GET /api/jobs`
handed over the list to ask from.

## Two safe defaults

**The server binds `127.0.0.1` unless told otherwise.** `HOST` overrides it. An
unauthenticated prototype should not become network-reachable because nobody
set a variable.

**`AUTH=none` is refused on a non-loopback bind.** Serving other people's video
to an unauthenticated network is something to choose, not to inherit:

```
Refusing to serve unauthenticated on 0.0.0.0. Anyone who can reach this port
could read every uploaded video. Set AUTH=token with API_TOKENS, or bind to
127.0.0.1 for local development.
```

## Modes

| `AUTH` | Behaviour |
| --- | --- |
| `none` (default) | Every caller is `anonymous`. Loopback only. |
| `token` | `Authorization: Bearer <token>` against `API_TOKENS`. Any bind. |

```bash
AUTH=token API_TOKENS='alice:a-long-random-token,bob:another-long-one' HOST=0.0.0.0 npm start
```

`API_TOKENS` is `principal:token` pairs. A malformed entry is a startup error
rather than a silently dropped one — a dropped entry is an account that stops
working with nothing to explain why. Tokens under 16 characters are refused,
and comparison is constant-time across the whole list, so neither the value nor
its position leaks through timing.

## What ownership means

Every job records the principal that created it, and all three read paths are
scoped to it:

| Route | Scoping |
| --- | --- |
| `GET /api/jobs` | Only the caller's jobs. There is no unscoped listing. |
| `GET /api/jobs/:id` | **404** for another principal's job |
| `GET /api/jobs/:id/shorts/:n` | Ownership checked against the store, then **404** |

**404 rather than 403 is deliberate.** A 403 confirms the ID exists, which
turns a guessed job ID into an oracle. A 404 leaves a prober no better off than
before they asked.

The Short route checks the store rather than trusting the storage key, because
a rendered Short is the most sensitive artefact here and its key follows
directly from the job ID.

Job IDs are `randomUUID`. They were a timestamp plus `Math.random`, which is
predictable from the prefix and recoverable from a couple of observed values.

## What this is not

`StaticTokenAuthenticator` is a real implementation, not a placeholder, but it
is not a user system: no sign-up, no rotation, no revocation beyond editing the
environment and restarting. A Supabase or OIDC authenticator implements the
same `Authenticator` interface and nothing downstream changes — that is what
the seam is for.

One gap is worth stating plainly. The web client sends a bearer token on
`fetch`, but a rendered Short is played through `<video src>`, which cannot
carry a header. Under `AUTH=token` those requests arrive unauthenticated and
get a 401. Closing it needs either a cookie session or short-lived signed URLs,
and which of those is right depends on the auth model you pick — so the client
is left honest about the limitation rather than guessing.
