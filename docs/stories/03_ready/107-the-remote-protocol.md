# 107 — The remote protocol

**Epic:** K — Moving content · **Priority:** should · **Size:** L
**Depends on:** 104, 105, 106

## Story

As someone running a site, I want my site to answer a small, documented
protocol for sending and receiving whole sites, so that a developer's
`crombolo` can pull a copy from it and push work back to it, whoever hosts
it.

## Context

`104` writes a whole site into one file and `105` starts or replaces a site
from one. Between two machines, that file still has to be carried by hand.

A **remote** is a running site that will hand out and accept those files
over HTTPS, to someone allowed to ask. The CMS's rule holds: a transfer
produces a file, and no environment keeps credentials for another. What is
new is only who carries the file. Here it is the developer's own `crombolo`
(`108`), holding the developer's own credentials, on their own machine.

The protocol is open and versioned, so any host can implement it: a
self-hosted production server, a hosting company, a platform. The CMS's own
server is the reference implementation.

## Acceptance criteria

- [ ] **A public, versioned specification** in `docs/remote-protocol.md`,
      the contract other implementations are held to. It covers:
      - discovery;
      - signing in;
      - listing environments;
      - export;
      - import;
      - progress;
      - approvals;
      - errors.
- [ ] **Discovery.** `GET /.well-known/crombolo-remote` names the protocol
      versions served, the sign-in endpoints, and the environments the
      remote offers. Each environment is named, and says whether it is
      `protected`: a push there replaces something people rely on.
- [ ] **Signing in** is the OAuth 2.0 device authorization grant (RFC 8628).
      The CLI shows a code, the person approves it in a browser where they
      are already signed in, and the CLI receives a short-lived token for
      that person with that person's permissions. The tokens can be listed
      and revoked from the back office.
- [ ] **Pull:**
      - a request for an environment's whole-site file (`104`) starts an
        export, reports its progress, and ends in a short-lived download;
      - people are anonymised unless a full copy is asked for, and a full
        copy needs a permission of its own;
      - it is sealed with a passphrase the requester gives, and is recorded.
- [ ] **Push:**
      - an upload of a whole-site file starts an import that replaces the
        environment (`105`), and reports its progress;
      - a backup is taken before anything is replaced, wherever the remote
        can take one;
      - a push to a `protected` environment needs a permission of its own.
- [ ] **Approval required.** A remote may answer any request with "approval
      required", giving a URL where a person approves that one action, and
      a way to wait for the outcome. The protocol says nothing about how the
      approval is decided: that is the remote's business.
- [ ] **The CMS's own server implements it,** behind a setting that is off
      by default, with the back-office permissions for pull, full pull,
      push and protected push. So a self-hosted site is a remote with one
      setting.
- [ ] **A conformance suite** in the repository, which any implementation
      can run against its own endpoint, and which the CMS's server passes.

## Out of scope

- Live sync, and partial pulls or pushes. A remote moves whole sites;
  `content export` and `content import` still move parts.

## Decision (2026-10-16)

- **Job files live in the media store.** A pull's export and a push's upload go
  under a temporary prefix (`.remote/<job>/`) in whichever store the site uses
  (file system, S3 or Azure). That way every node in a cluster can serve the
  download, and a store with presigned links hands one out. Job state is in the
  database. Expired files are swept by the background job that already sweeps
  temporary uploads.
- **A push uploads with one streaming `PUT`.** It carries the `.tgz` with its
  length and SHA-256, and a failed upload is retried from the start. This keeps
  it simple for any host; resumable chunks can come in a later protocol version.
- **Sealing follows the normal bundle rules: metadata in the open, content data
  sealed.**
  - Node structure, names, schema and files stay readable.
  - Property values, media files and people are sealed under the passphrase the
    requester gives.
  - `export --site` gains `content: 'sealed'`. That changes 104, which writes
    content in the open today.
  - A push is sealed the same way: the CLI generates a passphrase for each push
    and sends it with the upload over TLS. The file is then unreadable while it
    sits in the remote's store.
- **The CMS's own server can require approval for protected pushes.** It is off
  by default. When on, a push to a protected environment waits until someone
  else with the protected-push permission approves it in the back office. The
  reference server then exercises the protocol's approval path, and the
  conformance suite tests it against a real implementation.

### To confirm when building starts

- **Sealing media while streaming.** Recommended: seal each media file whole,
  one at a time, with the existing `sealBytes`. Only one file is in memory at
  once, the format stays 3, and every reader already opens it. The cost is that
  a single very large file, such as a long video, is held in memory while it is
  sealed. The alternative is a chunked seal for media, which streams but needs
  format 4.
- **Assigning the permissions.** Four verbs: `Crombolo.Remote.Pull`,
  `.PullFull`, `.Push` and `.PushProtected`. The administrators group gets them
  from the seed and a migration. Making them assignable in the user group editor
  needs Umbraco's `entityUserPermission` extension to show verbs that aren't
  tied to a node. That has to be checked against the vendored back office
  first; if it can't, a small permissions view in Users does the job.

## Plan

**The protocol, version 1** (`docs/remote-protocol.md`):

| | |
| --- | --- |
| `GET /.well-known/crombolo-remote` | versions served, the site's name, the API base, the sign-in endpoints, the environments (`id`, `name`, `protected`) |
| `POST <auth>/device` | RFC 8628 device authorization: `device_code`, `user_code`, `verification_uri(_complete)`, `interval`, `expires_in` |
| `POST <auth>/token` | `grant_type=urn:ietf:params:oauth:grant-type:device_code`, answering `authorization_pending`, `slow_down`, `expired_token` or `access_denied` until approved |
| `GET <api>/environments` | the same list, for the signed-in person, with what they may do in each |
| `POST <api>/environments/{id}/pulls` | `{ full, media, passphrase }` → `202` with a job |
| `PUT <api>/environments/{id}/pushes` | the `.tgz` body, `Content-Length`, `Crombolo-Sha256` and `Crombolo-Passphrase` headers → `202` with a job |
| `GET <api>/jobs/{id}` | `state` (`queued`, `running`, `approval-required`, `done`, `failed`, `refused`), `stage`, `progress`, `approvalUrl`, `download` (`url`, `expiresAt`), `problem` |
| `GET <api>/jobs/{id}/download` | the file, when the store has no presigned link |

Errors are `application/problem+json` with a stable `code`. A client polls a
job at the interval the job states, and "approval required" is a job state
rather than an error, so the client waits on the job in the same way.

**The CMS's own server:**
1. **Settings.** `remote: { enabled, environment, protected, approvals }`, off
   by default. The server offers one environment, itself, named by
   `environment` (default `production`) and `protected` by default.
2. **Device authorization.**
   - A new grant on the existing auth server.
   - Migration 041 (release 0.14.0) adds the `device_authorization` table:
     device code hash, user code, expiry, approved-by, the access token issued.
   - A back-office page at `<backoffice>/device` takes the user code and
     approves it for the signed-in person.
   - Tokens are the existing reference tokens, marked as a device sign-in with
     a short lifetime and a refresh.
   - A "Signed-in devices" list, where each sign-in can be revoked, goes in the
     current user's profile, and an administrator can see it in Users.
3. **Jobs.**
   - A `remote_job` table: kind, environment, requester, state, stage,
     progress, media-store key, expiry, approval.
   - A job runs in-process on the node that took the request, and a node that
     stops leaves its job marked failed when it goes stale.
   - A pull runs `exportSite` (sealed, anonymised unless `full`) to a local
     temporary file, then streams it into the store.
   - A push streams the upload into the store, checks its hash, then downloads
     it to a local temporary file and runs `installBundleContent` with
     `--replace`, after a backup.
4. **Permissions** are checked on every pull, full pull, push and protected
   push. Every job is written to the audit log.
5. **Approvals.**
   - With `approvals` on, a protected push stops at `approval-required`, with a
     link to a back-office approval page.
   - Another person with `PushProtected` approves or declines it there.
   - The requester can't approve their own push, and an approval expires.

**The conformance suite** is `packages/remote-conformance`, a runner that
takes `<url>` and a token or device sign-in and checks each part of the
specification. The CMS server passes it in `tests/remote-conformance.test.ts`,
on both dialects. It doesn't depend on the server package, so another host can
run it unchanged.

**Tests:**
- device flow: pending, slow down, approve, deny, expiry;
- discovery;
- pull, anonymised and full, with permissions refused;
- push, unprotected and protected, with approval approved, declined and
  expired;
- jobs across a node restart going stale;
- download expiry;
- tampered upload hash.
