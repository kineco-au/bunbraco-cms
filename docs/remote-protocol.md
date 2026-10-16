# The remote protocol, version 1

A **remote** is a running site that hands out, and accepts, whole-site files
([`content-transfer.md`](content-transfer.md), "A whole site in one file") over
HTTPS, to a person allowed to ask. A developer's `crombolo` CLI pulls a copy of
it and pushes work back (story `108`). The CMS's own server is the reference
implementation (story `107`). Any host may implement the protocol, and
`@crombolo/remote-conformance` checks one against it.

The CMS's rule holds. A transfer produces a file, and no environment keeps
credentials for another. The CLI carries the file, under the developer's own
sign-in.

Everything here is required unless marked optional. All bodies are JSON unless
stated otherwise. Errors are `application/problem+json` with a stable `code`
(see Errors).

## Discovery

`GET /.well-known/crombolo-remote`, unauthenticated:

```json
{
  "protocol": "crombolo-remote",
  "versions": ["1"],
  "name": "Harbourstone Distillery",
  "api": "https://example.com/umbraco/remote/v1",
  "auth": {
    "deviceAuthorization": "https://example.com/…/security/back-office/device",
    "token": "https://example.com/…/security/back-office/token",
    "clientId": "crombolo-cli",
    "grantType": "urn:ietf:params:oauth:grant-type:device_code"
  },
  "capabilities": ["media-fetch", "approvals"],
  "environments": [{ "id": "production", "name": "production", "protected": true }]
}
```

- **`versions`:** the protocol versions served. A client refuses a remote that
  serves none it speaks.
- **`api`:** the base for everything below. It need not share the discovery
  document's origin.
- **`environments`:** what the remote offers.
  - `id` is lower case letters, digits and dashes.
  - `protected: true` means a push there replaces something people rely on.
- **`capabilities`:** optional features.
  - `media-fetch` means media by reference is offered (see below).
  - `approvals` means a push may wait for approval.
  - A client ignores capabilities it doesn't know.

A site that isn't a remote answers 404.

## Signing in

The OAuth 2.0 device authorization grant ([RFC 8628]). The client never sees
the person's password, and the remote's own sign-in (password, two-factor,
identity provider) is whatever it already is.

1. `POST <auth.deviceAuthorization>`, form-encoded, with `client_id=<auth.clientId>`
   and optionally `client_name`, which the approval page shows. The answer:
   `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`,
   `expires_in`, `interval`.
2. The client shows `user_code` and opens `verification_uri_complete`. The
   person approves or declines there, in a browser where they are signed in.
3. The client polls `POST <auth.token>` with `grant_type=<auth.grantType>`,
   `device_code` and `client_id`, no faster than `interval`. Until a decision
   the answer is 400 with `error` set to one of:
   - `authorization_pending`;
   - `slow_down` (add 5 seconds to the interval);
   - `expired_token`;
   - `access_denied`.
4. Approved, the answer is `access_token`, `refresh_token`, `token_type: Bearer`
   and `expires_in`. A device code yields tokens once.
5. The client refreshes with `grant_type=refresh_token`, `refresh_token` and
   `client_id`. The tokens act as the person who approved, with that person's
   permissions, until revoked.

Every request below sends `Authorization: Bearer <access_token>`. Without one,
or with one that has lapsed, the answer is 401 `sign-in-required`.

In the reference server, the person approves at `<backoffice>/device`. Each
sign-in becomes a session listed under **Signed-in devices** in their profile,
where they can sign it out.

## Environments

`GET <api>/environments` lists the environments, each with what this person
may do:

```json
[{ "id": "production", "name": "production", "protected": true,
   "may": { "pull": true, "pullFull": false, "push": true } }]
```

`push` is already false where the environment is protected and the person
lacks the permission for that.

## Jobs

Pulls and pushes are **jobs**. Starting one answers `202` with the job.
`GET <api>/jobs/{id}` answers it again until it settles:

| Field | |
| --- | --- |
| `id`, `kind` (`pull` or `push`), `environment` | |
| `state` | `queued`, `running`, `approval-required`, `done`, `failed`, `refused` |
| `stage`, `progress` | where it has got to, and a percentage, both optional |
| `pollAfter` | seconds until it is worth asking again, while it is still moving |
| `download` | a finished pull: `url`, `expiresAt`, `size`, `sha256` |
| `approvalUrl`, `approvalExpiresAt` | while `approval-required` |
| `problem` | a failed or refused job: `code`, `title`, `detail`, `items` |
| `runId` | a finished push: the import's run, which `content revert` undoes |

A job is visible to the person who started it. On a remote with approvals,
it's also visible to whoever may approve it. Anyone else gets 404.

- **`failed`** means something went wrong, and asking again may work.
- **`refused`** means the remote declined: an import's checks, a decline, or
  an approval that expired.

A job whose worker stopped is reported `failed` with `interrupted`; it never
stays running forever.

## Pulling

`POST <api>/environments/{id}/pulls`:

```json
{ "passphrase": "at least twelve characters", "full": false, "media": "included" }
```

- **`passphrase`** (required, 12+ characters) seals the file.
  - Metadata stays readable: structure, names, schema, files.
  - Content data is sealed: property values, media files, and any people.
- **`full`:** with `false` (the default) people are anonymised. Members become
  placeholders, back-office users are left out, and every email address is
  replaced. `true` carries members and users and needs the full-pull
  permission.
- **`media`** is one of:
  - `included` (the default): the media files are in the file;
  - `omitted`: they aren't;
  - `referenced`: they aren't, and they are fetched one at a time (below).

The finished job's `download.url` serves the file for as long as
`download.expiresAt` allows. A client checks it against `download.sha256`. The
reference server serves downloads only through the API with the bearer token,
never from the media store's public address.

## Pushing

`PUT <api>/environments/{id}/pushes`:
- **Body:** the whole-site file (`application/gzip`).
- **`Content-Length`:** the file's size.
- **`Crombolo-Sha256`:** the file's SHA-256, in hex.
- **`Crombolo-Passphrase`:** the passphrase it was sealed with.

The remote refuses a file whose hash doesn't match (400 `hash-mismatch`)
before anything is replaced. Accepted, the push is a job that:
1. backs up where the remote can;
2. replaces the environment with the file, as `crombolo import --replace` does.

A push to a protected environment needs the protected-push permission (403
`forbidden-protected` otherwise).

## Approvals (optional)

A remote may answer a push with a job in `approval-required`, with an
`approvalUrl` where a person decides that one push. The client waits on the
job as on any other. The protocol says nothing about how the decision is
made.

In the reference server, with `remote.approvals` on, a push to a protected
environment waits:
- **Who decides:** someone else with the protected-push permission, through
  `POST <api>/jobs/{id}/approve` or `…/decline`, or the page at
  `<backoffice>/remote-approval?job=<id>`.
- **Self-approval:** a person can't approve their own push (403 `own-push`).
- **Expiry:** an approval expires after a day (`approval-expired`).
- **The passphrase:** kept meanwhile, sealed with `CROMBOLO_SECRET_KEY`, so
  approvals need that key.

## Media by reference (`media-fetch`, optional)

For a site whose media would make a file too big to move comfortably, the
file carries media metadata only. The manifest says `media: "referenced"`, and
every blob is named with its key, size and etag.

| | |
| --- | --- |
| `POST <api>/environments/{id}/media/links` `{ "keys": [...] }` | up to 500 keys at a time; `{ "links": { key: { url, size, etag } \| null } }`, where a link may be the store's own presigned URL or `GET <api>/environments/{id}/media/{key}` |
| `POST <api>/environments/{id}/media/have` `{ "blobs": [{ key, etag? }] }` | `{ "have": [keys] }`: those the remote holds, with the same etag when given |
| `PUT <api>/environments/{id}/media/{key}` | one media file, with `Crombolo-Sha256`; 204 |

- **Pull:** pull with `media: "referenced"`, then fetch each file the client
  doesn't already hold with the same etag.
- **Push:** ask `have`, upload what is missing, then push a file whose media is
  referenced. The import refuses while any referenced file isn't in the store,
  and names them.
- **Permissions:** the same as pulling and pushing.

## Errors

| Status | `code` | |
| --- | --- | --- |
| 400 | `passphrase-required`, `hash-required`, `hash-mismatch`, `body-required`, `bad-key`, `too-many` | the request is wrong |
| 401 | `sign-in-required` | no token, or a lapsed one |
| 403 | `forbidden`, `forbidden-protected`, `own-push` | the person may not |
| 404 | `not-found`, `no-such-environment`, `not-enabled` | |
| 409 | `not-waiting`, `approval-expired` | the job is not in a state for that |
| 410 | `gone` | the download has expired |
| 413 | `too-large` | over the remote's upload limit |
| 503 | `approvals-unavailable` | the remote cannot hold a push for approval |

## The reference server

Off by default:

| Setting | |
| --- | --- |
| `remote.enabled` / `CROMBOLO_REMOTE_ENABLED` | answer the protocol |
| `remote.environment` / `CROMBOLO_REMOTE_ENVIRONMENT` | this server's environment, default `production` |
| `remote.protected` / `CROMBOLO_REMOTE_PROTECTED` | default true |
| `remote.approvals` / `CROMBOLO_REMOTE_APPROVALS` | protected pushes wait for approval; needs `CROMBOLO_SECRET_KEY` |
| `remote.maxUploadBytes` / `CROMBOLO_REMOTE_MAX_UPLOAD_GB` | default 50 GB, for pushes and media uploads only |

**Permissions.** Each is a user group permission under "Moving whole sites":

| Permission | |
| --- | --- |
| `Crombolo.Remote.Pull` | pull |
| `Crombolo.Remote.PullFull` | a full pull |
| `Crombolo.Remote.Push` | push |
| `Crombolo.Remote.PushProtected` | push to, and approve pushes to, a protected environment |

Administrators have all four.

**How it runs:**
- **Where jobs live.** A job runs on the node that took it. Its state is in
  `remote_job` and its file in the media store under `.remote/`, so any node
  in a cluster answers a poll or a download.
- **Clean-up.** Files go an hour after a job finishes, and rows a day after
  that.
- **Upload size.** Only the push and media upload routes take bodies beyond
  `maxRequestBodyBytes`; every other route keeps that limit.
- **Audit.** Every pull, push and approval decision is written to the audit
  log.

## Conformance

```bash
bunx crombolo-remote-conformance https://example.com --token <token> [--environment <id>] [--push]
```

The suite is read-only unless `--push` is given. It covers:
- discovery and the device endpoint;
- the API's refusals;
- environments;
- a pull to completion, checked against its stated hash;
- media links, when offered;
- a refused tampered push;
- with `--push`, a full push.

The reference server passes it in `tests/remote-conformance.test.ts` on both
database dialects.

[RFC 8628]: https://www.rfc-editor.org/rfc/rfc8628
