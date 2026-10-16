# 108 — crombolo pull and push

**Epic:** K — Moving content · **Priority:** should · **Size:** M
**Depends on:** 107

## Story

As a developer, I want to pull a working copy of any site I'm allowed to,
and push my work back, with one command, so that moving between my machine
and wherever the site runs takes minutes.

## Context

`107` makes a running site a remote. This is the developer's side: the
`crombolo` CLI they already use for `init`, `start` and `content`, learning a
handful of commands that speak the protocol.

## Acceptance criteria

- [x] `crombolo remote add <name> <url>`, `remote list` and `remote remove`,
      kept in the site's folder, as git keeps its remotes. Adding a remote
      reads its discovery document and lists its environments.
- [x] `crombolo login <remote>` signs in by the device flow:
      - it shows a code and opens the browser;
      - it keeps the token in the operating system's keychain, never in the
        folder;
      - `logout` and `whoami` work against each remote.
- [x] `crombolo pull [<remote>] [--env <name>] [--full] [--no-media]`:
      - fetches the environment's whole-site file and starts it locally
        (`105`), on SQLite unless told otherwise;
      - for a typical site, ready to browse in under five minutes;
      - anonymised unless `--full`, which asks for a passphrase.
- [x] `crombolo push [<remote>] [--env <name>]` exports the local site (`104`)
      and sends it:
      - **an environment that is not `protected`:** it is replaced without a
        prompt;
      - **a `protected` one:** the push refuses without `--force`, and with
        it shows what will be replaced and asks for a typed confirmation,
        unless `--auto-approve` is also given;
      - the flags are the CLI's own guard against a slip, and never
        authority: the remote decides.
- [x] **When the remote answers "approval required"** (`107`), the CLI opens
      the approval URL, says what it is waiting for, and carries on or stops
      with the outcome. That is the same whether the flags were given or
      not.
- [x] **Progress** is reported stage by stage from the remote's own
      reporting, and the exit codes are stated:
      - 0 done;
      - 1 the remote refused or failed;
      - 2 refused before anything was sent;
      - 3 gave up waiting.
- **`crombolo clone --anonymise`** (`100`) is `pull` with anonymising
  required. Moved to story `100`, built after this one (decided 2026-10-16).
- [x] **Tested** against the CMS's own server as a remote, end to end:
      pull, change, push to an unprotected environment, then a refused
      protected push without `--force`.

## Plan (2026-10-16, after 107's decisions)

Decided (2026-10-16):
- **Remotes live in `remotes.toml` at the site's root**, committed: names and
  URLs only, never credentials, so a team shares where its environments are.
- **Pulling into a folder that already holds a site** replaces it, as
  `import --replace` does: the summary first, a prompt unless `--yes`, and
  `content revert` undoes it. In an empty folder it is `start --from`.
- **Clone is story `100`**, built after this on top of `pull`.
- **A push can be checked before it is sent.** Protocol v1 gains an optional
  capability, `push-check`: `POST <api>/environments/{id}/pushes/check` takes
  the file's manifest and nothing else (no upload). It answers what the push
  would bring, recycle, remove and leave alone, and what it would refuse — the
  summary `crombolo import` prints locally (`siteReplaceCheck`). It's built
  here, in the server, the spec and the conformance suite. Against a remote
  without the capability, the CLI shows a local summary of what it is sending
  instead.

**Layout.** `packages/cli/src/remote/`:
- `client.ts`: discovery, the device flow and refresh, API calls, job polling,
  download and upload streaming;
- `keychain.ts`: `Bun.secrets` behind a small interface, with an in-memory
  one for tests;
- `remotes-file.ts`: reads and writes `remotes.toml`;
- `pull.ts` and `push.ts`: the commands as functions that return results.

`bin/crombolo.ts` prints those results, as for every other operation.

**Commands** (`packages/cli`, on a small protocol client in
`packages/cli/src/remote/`):
1. `remote add <name> <url>`, `remote list` and `remote remove`. Adding reads
   the discovery document, refuses a protocol version it doesn't speak, and
   lists the environments.
2. `login <remote>`, `logout` and `whoami`.
   - Login runs the device flow: it prints the code, opens the browser and
     polls.
   - Tokens are kept with `Bun.secrets` (macOS Keychain, Windows Credential
     Manager, libsecret on Linux), keyed by the remote's URL, and never written
     to the folder.
   - A refresh token keeps a sign-in going until it is revoked.
3. `pull [<remote>] [--env <name>] [--full] [--no-media] [--yes]`:
   1. starts a pull job and reports its stages;
   2. downloads the file;
   3. runs `start --from`, or the replace into the current site.

   It's anonymised unless `--full`. A passphrase is generated for each pull
   and kept only in memory, since the same command both asks for the file and
   opens it.
4. `push [<remote>] [--env <name>] [--force] [--auto-approve]`:
   - exports the local site with sealed content and a passphrase generated for
     the push;
   - asks the remote's `pushes/check` (or builds a local summary) and prints
     it;
   - refuses a protected environment without `--force`;
   - with `--force`, asks for the environment's name to be typed back unless
     `--auto-approve` is given;
   - then uploads, streaming, and follows the job.

   An `approval-required` state prints the approval link, opens it, and
   waits, whatever flags were given.
5. **Exit codes:** 0 done; 1 the remote refused or failed; 2 refused before
   anything was sent; 3 gave up waiting (`--timeout`, default 30 minutes).
6. **The server's `pushes/check`** (`server/src/remote.ts`):
   - It runs `replaceSummary` and the content check against the posted
     manifest, with no upload and nothing written.
   - It needs `Push`, and `PushProtected` for a protected environment.
   - Discovery advertises it, and `docs/remote-protocol.md` and the
     conformance suite cover it.

**Tests** (`tests/remote-cli.test.ts`): the CMS server is started as a remote
with `remote.enabled`, and the CLI's operations are driven against it, with
the device approval done through the back-office endpoint:
1. pull into an empty folder;
2. change a page;
3. push to an unprotected environment, and check the remote has the change;
4. a protected push refused without `--force` (exit 2);
5. one with `--force --auto-approve` stopping at approval;
6. `pushes/check` naming what the remote would recycle;
7. `remote add` refusing a site that is not a remote;
8. a lapsed token refreshed without a new sign-in.

`Bun.secrets` is stubbed in tests behind a small keychain interface, since CI
has no keychain.

## Media by reference: `--media-info-only` (2026-10-16)

`107` § Media by reference describes the protocol side. On the CLI:

- **`pull --media-info-only`** asks for a file that carries media metadata
  only, starts or replaces the local site from it, and then fetches the media
  files:
  - it asks the remote for links in batches and downloads in parallel, retrying
    each file on its own;
  - it puts each file into the local media store, whichever store that is;
  - it skips any file already there with the same key and etag, so after the
    first pull a pull downloads only the media that changed;
  - progress is reported in files and bytes;
  - if a download fails, the pulled site is still in place: the files are
    listed, and `pull --media-info-only` again fetches only what is missing.
- **`pull --media-info-only --lazy-media`** downloads nothing up front. The
  local site's media store becomes a read-through cache: a file missing
  locally is fetched from the remote the first time it is requested, under the
  stored sign-in, then kept. A pull is close to instant, but until each file
  has been viewed once, local media needs a connection and a valid sign-in. A
  file that can't be fetched answers 404 and says why in the log.
  `crombolo media fetch` downloads whatever is still missing, for working
  offline.
- **`push --media-info-only`** exports the site with media referenced, asks the
  remote which media files it already has, uploads only the missing or changed
  ones one at a time, then sends the file. The remote's import waits until
  every referenced file is present.
- **Without `--media-info-only`**, pull and push move one self-contained file
  as before. Against a remote that doesn't advertise `media-fetch`, the flag
  says so and falls back to the whole file.
- **`export --site` is unchanged** and always self-contained, because a file
  with referenced media is no use without its remote.

**Extra tests:**
- a referenced pull, then a second pull that downloads nothing new;
- a lazy pull serving a media file on first request;
- a push that uploads only a changed file;
- the fallback against a remote without the capability.

## Implementation (2026-10-16)

- **The client** (`packages/cli/src/remote/`):
  - `client.ts`: `discover`, which refuses a site that isn't a remote or that
    speaks other versions, and `signIn` (RFC 8628).
  - `RemoteClient`: calls refresh a lapsed sign-in once on a 401. It also does
    `settle` for job polling (with progress and the approval callback) and
    `download`, which is streamed and hash-checked.
  - `remotes-file.ts`: `remotes.toml`.
  - `transfer.ts`: `pullFile`, `fetchReferencedMedia`, `referencedBlobs` and
    `pushSite`.
- **Credentials** (`server/src/remote-credentials.ts`): a `Keychain` over
  `Bun.secrets`, keyed by the API's origin, with `freshAccessToken` doing the
  refresh, and a memory keychain for tests.
- **Lazy media** (`server/src/remote-media.ts`): with
  `.crombolo/remote-media.json`, `withRemoteMedia` wraps only the store the
  site serves from. A missing file is fetched under the sign-in and kept.
  Exports read the plain store.
- **The server's `push-check`** (`pushes/check`): it answers what a push would
  recycle and remove, from node keys and section paths alone. It's in the
  spec, in discovery and in the conformance suite.
- **CLI** (`bin/crombolo.ts`):
  - `remote add`, `list` and `remove`;
  - `login`, `logout` (which also revokes the sign-in at the remote) and
    `whoami`;
  - `pull [--env] [--full] [--yes] [--no-media | --media-info-only |
    --lazy-media]`;
  - `push [--env] [--force] [--auto-approve] [--media-info-only]`;
  - `media fetch`;
  - the exit codes 0 to 3.
  - A pull into an empty folder runs `start --from` with the pull's own
    passphrase (`startFromFile` now takes one, and opens sealed content).
  - A pull into a site replaces it, after the summary and a prompt.
- **One difference from the criteria:** `--full` doesn't ask for a passphrase.
  Each pull seals its file with a passphrase made for it and kept in memory,
  since the same command asks for the file and opens it. That's simpler, and
  never weaker.
- **Media fetch** records the remote etags it fetched
  (`.crombolo/remote-media-fetched.json`), because local and remote stores
  give different etags for the same file. A second pull downloads only what
  changed.
- **Docs:** `docs/operations.md`, `docs/remote-protocol.md`, the README, and
  the CLI help.
- **Tests:**
  - `tests/remote-cli.test.ts` (8), on both dialects. The local site is always
    SQLite in a file of its own. It covers:
    - `remotes.toml`;
    - discovery refusing a plain site;
    - a lapsed token refreshed without a new sign-in;
    - pull, change and push reaching the remote;
    - a protected push refused without `--force`, refused without
      confirmation, then held for approval and approved by a colleague;
    - a person who may not pull, refused before anything is asked;
    - media by reference, with a second pull fetching nothing new;
    - a push by reference uploading only the missing file;
    - lazy media read through.
  - `tests/remote.test.ts` covers `push-check`.
- **Not timed:** the "under five minutes" pull.
