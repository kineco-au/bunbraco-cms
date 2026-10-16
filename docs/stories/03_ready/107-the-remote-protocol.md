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
