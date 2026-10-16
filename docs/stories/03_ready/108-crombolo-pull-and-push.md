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
