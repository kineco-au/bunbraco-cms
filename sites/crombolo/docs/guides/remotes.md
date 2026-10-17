---
title: Remotes, pull and push
summary: Connect your local site to a running one, sign in from the terminal, pull a copy down to work on, and push your work back.
order: 4
---

A **remote** is a running crombolo site that your local copy can pull from and push to. Pulling gives you a working copy of an environment, content and all; pushing replaces an environment with your local site. It works like `git pull` and `git push`, but for a whole site: schema, templates, content and media.

Under the hood it is the same whole-site file described in [Content transfer](/docs/guides/content-transfer/), carried for you over HTTPS under your own sign-in. No environment stores credentials for another.

## Turning it on at the remote

A site answers pulls and pushes only when it is told to. On the site you want to reach, set:

```sh
CROMBOLO_REMOTE_ENABLED=true
CROMBOLO_REMOTE_ENVIRONMENT=staging     # what this site calls itself; production by default
CROMBOLO_REMOTE_PROTECTED=false         # true by default: a push needs extra permission
```

| Setting | Default | What it does |
| --- | --- | --- |
| `CROMBOLO_REMOTE_ENABLED` | `false` | answer pulls and pushes |
| `CROMBOLO_REMOTE_ENVIRONMENT` | `production` | the environment's name, as the command line sees it |
| `CROMBOLO_REMOTE_PROTECTED` | `true` | a push here is a push to a protected environment |
| `CROMBOLO_REMOTE_APPROVALS` | `false` | a push to a protected environment waits for someone else to approve it; needs `CROMBOLO_SECRET_KEY` |
| `CROMBOLO_REMOTE_MAX_UPLOAD_GB` | `50` | the largest file a push may upload |

### Who may do what

Four permissions, under **Moving whole sites** on a user group in the back office:

| Permission | Allows |
| --- | --- |
| Pull a copy | download a copy with members and users anonymised |
| Pull a full copy | download a copy that includes members and users |
| Push | replace an unprotected environment |
| Push to a protected site | replace a protected environment, and approve or decline other people's pushes to it |

A pull or push acts as the person who signed in, with that person's permissions, and every one is recorded in the audit log.

## Adding a remote

In your local site's folder:

```sh
bunx crombolo remote add staging https://staging.example.com --env staging
bunx crombolo remote list
```

`remote add` checks that the address really is a crombolo remote before it saves it. Remotes are kept in `remotes.toml` in the site's folder, which holds addresses only, so commit it and the rest of your team gets the same remotes.

## Signing in

```sh
bunx crombolo login staging
```

`login` prints a short code and opens a page in the remote's back office where you approve it, in a browser where you are already signed in. Your password, two-factor code or identity provider never pass through the terminal. `--no-browser` prints the address instead of opening it, for a machine without one.

The sign-in is kept in your operating system's keychain, never in the site's folder, and is refreshed as it runs out. You can see every terminal signed in as you under **Signed-in devices** in your back-office profile, and sign any of them out there.

```sh
bunx crombolo whoami staging    # who you are there, and what you may do
bunx crombolo logout staging    # sign out, here and at the remote
```

When a site has only one remote, you can leave its name off every command.

## Pulling

```sh
bunx crombolo pull staging
```

What `pull` does depends on where you run it:

- **In an empty folder** it creates a new site from the remote and starts it, printing a fresh administrator's password.
- **In a site** it replaces that site with the remote's copy. It says first what will be moved to the recycle bin, and asks before going ahead; `--yes` skips the question.

A pull is sealed and anonymised unless you ask otherwise: members become placeholders, back-office users are left out, and every e-mail address in the content is replaced. `--full` brings the real people, and needs the permission for it.

When a site's media library is large, you choose how its files come down:

| Flag | Media files |
| --- | --- |
| none | downloaded with the site |
| `--media-info-only` | fetched one at a time, and only those that changed since your last pull |
| `--lazy-media` | fetched the first time your local site is asked for each one |
| `--no-media` | left out |

After a lazy pull, `crombolo media fetch` downloads everything that is still missing.

Pulling into a Postgres site replaces its database, so it needs a backup first: `CROMBOLO_PG_DUMP`, or `--backup-taken`.

## Pushing

```sh
bunx crombolo push staging --dry-run
bunx crombolo push staging
```

`push` replaces the remote environment with your local site. It always says first what it would move to the recycle bin and which files it would remove there; `--dry-run` stops at that point. The remote takes a backup where it can, then replaces itself as `crombolo import --replace` would, so what it loses goes to its recycle bin and its own people are kept.

A push to a protected environment needs two more things: `--force`, and the environment's name typed back to confirm it. In a pipeline, `--auto-approve` skips the typing.

```sh
bunx crombolo push production --env live --force --auto-approve
```

If the remote has approvals turned on, the push then waits for someone else with the protected-push permission to approve it in the back office. Nobody can approve their own push, and an approval not given within a day expires.

## Long transfers

Each pull and push runs as a job at the remote, so a site behind a load balancer needs nothing special. The command line waits for up to 30 minutes by default (`--timeout`, in seconds). If it gives up, the job carries on at the remote, and you can pick it up again with the id it printed:

```sh
bunx crombolo remote job 7c0e2d4a-…
```

## In scripts

Every command takes `-o json` and exits with a code a script can branch on. The ones a pull or push meets most often:

| Code | Means |
| --- | --- |
| 0 | done |
| 3 | gave up waiting; the job carries on at the remote |
| 4 | not signed in, or the sign-in has lapsed |
| 7 | it would have asked first, and there is no terminal to ask on |
| 8 | the remote said no: a permission, a protected environment, a declined approval |
| 9 | the remote could not be reached |

The rest are in the [exit codes](/docs/reference/exit-codes/) reference.

## Where next

- [The remote commands](/docs/reference/command-line/remotes/), with every flag
- [Content transfer](/docs/guides/content-transfer/), for moving part of a site rather than all of it
