# Storage

The pipeline never talks to a storage provider directly. It depends on the
`StorageAdapter` interface in `src/storage/types.ts`, and `createStorage()`
picks the implementation from `STORAGE_DRIVER`.

| Driver | Use |
| --- | --- |
| `local` | Development and tests. Writes under `LOCAL_STORAGE_DIR`. |
| `google-drive` | Google Drive as the backing store. |

## Key layout

Everything is addressed by POSIX-style key. `jobKeys` in `src/storage/index.ts`
owns the canonical layout so producers and consumers cannot drift:

```
jobs/<jobId>/source.mp4          uploaded long-form video
jobs/<jobId>/audio.wav           extracted audio, transcription input
jobs/<jobId>/transcript.json     transcription adapter output
jobs/<jobId>/edit-plan.json      LLM clip-selection output
jobs/<jobId>/shorts/clip-01.mp4  rendered 9:16 output
```

Keys are validated before use. Absolute keys, `.`, `..`, and backslashes are
rejected, so a caller-supplied job ID cannot escape the storage root.

## Streaming

Source videos are large, so every transfer is a stream — no adapter method
buffers a whole media file in memory. `get()` accepts a byte range, which is
what lets the API serve `Range` requests to a mobile player without pulling the
entire file first.

## Setting up Google Drive

> **The Drive connector in Claude is not this.** That connector authenticates as
> you inside a Claude session. Your server cannot call it. The steps below set up
> credentials the running application owns.

1. In Google Cloud, create a project and enable the **Google Drive API**.
2. Create a **service account** and download its JSON key.
3. Create a **Shared Drive**, then a folder inside it for this app.
4. Share that folder with the service account's `client_email`, as **Content
   manager** or better — it needs to create files and folders.
5. Set the environment variables:

```bash
STORAGE_DRIVER=google-drive
DRIVE_ROOT_FOLDER_ID=<folder id from the folder URL>
DRIVE_SHARED_DRIVE_ID=<shared drive id>
GOOGLE_SERVICE_ACCOUNT_KEY='<contents of the JSON key file>'
```

### Why a Shared Drive is not optional

A service account has no Drive storage quota of its own. Uploading into a
personal *My Drive* folder fails at runtime with `storageQuotaExceeded`, and it
fails on the first upload rather than at startup. Files in a Shared Drive are
owned by the Shared Drive, so the quota problem disappears.

`googleDriveStorageFromEnv()` refuses to start in that configuration rather than
letting it fail mid-job. If you are using OAuth *user* credentials — which do
have a quota — set `DRIVE_ALLOW_MY_DRIVE=true`.

## Two Drive behaviours worth knowing

**Drive has no paths.** It has a folder graph of opaque IDs, and sibling names
are allowed to collide. The adapter resolves each key segment by segment and
caches folder IDs, so writing a second clip into an already-resolved job folder
costs one API call rather than four.

**Name collisions resolve to the oldest match.** Two workers that concurrently
create `jobs/` produce two folders with that name. Sorting by creation time and
taking the oldest makes every worker converge on the same folder instead of
forking the tree.

## Links to finished Shorts

Drive cannot mint time-limited URLs. The only link an unauthenticated client can
use requires granting `anyone with the link` read access, which lasts until it
is revoked. `signedUrl()` therefore throws unless `DRIVE_ALLOW_PUBLIC_LINKS=true`,
and the `SignedUrl` it returns carries `expiresAt: null` so callers can tell the
difference.

For anything private, stream the bytes through your own API with `get()` and
keep the Drive file unshared.

## Tests

```bash
npm test
```

The Drive suite runs against an in-memory fake (`src/storage/__tests__/fakeDrive.ts`)
that reproduces ID-addressing and duplicate sibling names, so it needs no
credentials and no network.
