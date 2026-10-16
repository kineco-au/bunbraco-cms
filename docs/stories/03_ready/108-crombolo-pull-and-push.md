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

- [ ] `crombolo remote add <name> <url>`, `remote list` and `remote remove`,
      kept in the site's folder, as git keeps its remotes. Adding a remote
      reads its discovery document and lists its environments.
- [ ] `crombolo login <remote>` signs in by the device flow:
      - it shows a code and opens the browser;
      - it keeps the token in the operating system's keychain, never in the
        folder;
      - `logout` and `whoami` work against each remote.
- [ ] `crombolo pull [<remote>] [--env <name>] [--full] [--no-media]`:
      - fetches the environment's whole-site file and starts it locally
        (`105`), on SQLite unless told otherwise;
      - for a typical site, ready to browse in under five minutes;
      - anonymised unless `--full`, which asks for a passphrase.
- [ ] `crombolo push [<remote>] [--env <name>]` exports the local site (`104`)
      and sends it:
      - **an environment that is not `protected`:** it is replaced without a
        prompt;
      - **a `protected` one:** the push refuses without `--force`, and with
        it shows what will be replaced and asks for a typed confirmation,
        unless `--auto-approve` is also given;
      - the flags are the CLI's own guard against a slip, and never
        authority: the remote decides.
- [ ] **When the remote answers "approval required"** (`107`), the CLI opens
      the approval URL, says what it is waiting for, and carries on or stops
      with the outcome. That is the same whether the flags were given or
      not.
- [ ] **Progress** is reported stage by stage from the remote's own
      reporting, and the exit codes are stated:
      - 0 done;
      - 1 the remote refused or failed;
      - 2 refused before anything was sent;
      - 3 gave up waiting.
- [ ] **`crombolo clone --anonymise`** (`100`) is `pull` with anonymising
      required.
- [ ] **Tested** against the CMS's own server as a remote, end to end:
      pull, change, push to an unprotected environment, then a refused
      protected push without `--force`.

## Plan (2026-10-16, after 107's decisions)

Defaults to confirm before building:
- **Where remotes are kept: `remotes.toml` at the site's root,** committed.
  It holds names and URLs only, no credentials, so a team shares where its
  environments are. This differs from git, which keeps remotes uncommitted in
  `.git/config`. The other choice is `.crombolo/remotes.toml`, which isn't
  committed.
- **Pulling into a folder that already holds a site** replaces it as
  `import --replace` does: the summary is shown first, it asks unless `--yes`
  is given, and it can be undone with `content revert`. In an empty folder it
  is `start --from`.

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
   - refuses a protected environment without `--force`;
   - with `--force`, shows the remote's dry-run summary and asks for the
     environment's name to be typed back unless `--auto-approve` is given;
   - then uploads and follows the job.

   An `approval-required` state opens the approval link and waits, whatever
   flags were given.
5. **Exit codes:** 0 done; 1 the remote refused or failed; 2 refused before
   anything was sent; 3 gave up waiting (`--timeout`, default 30 minutes).
6. **`clone --anonymise <remote> [dir]`** is `pull` into a new folder with
   anonymising required. Without `--anonymise` it refuses unless `--trusted`
   is given, which closes story `100`.

**Tests** (`tests/remote-cli.test.ts`): the CMS server is started as a remote
with `remote.enabled`, and the CLI's operations are driven against it, with
the device approval done through the back-office endpoint:
1. pull into an empty folder;
2. change a page;
3. push to an unprotected environment, and check the remote has the change;
4. a protected push refused without `--force` (exit 2);
5. one with `--force --auto-approve` stopping at approval.

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
