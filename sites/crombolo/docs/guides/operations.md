---
title: Operations
summary: Keep a running site healthy: health checks, pausing editing, backups, rebuilding the cache and search indexes, logs, and looking after users.
order: 6
---

Once a site is deployed, most of looking after it is done from the command line in the site's folder. These commands open the site's database directly rather than going through the running server, so they work even when the site will not start. In a container, run them with `docker exec`.

The commands that change something write an entry in the audit log. Every command takes `-o json` for scripts, and exits with a code a script can branch on ([exit codes](/docs/reference/exit-codes/)).

## Health

There are three ways to ask whether a site is well, for three different callers.

### `/health`, for a load balancer

```sh
curl https://www.example.com/health
```

```json
{ "ok": true, "readOnly": false, "paused": null, "version": "1.0.0", "revision": "4573", "role": "all" }
```

It answers 200 when the node can do its job and 503 when it cannot: while it is starting, when it cannot reach the database, or when it has fallen behind the database during an upgrade and can no longer save. A public-site-only `web` node that has fallen behind still answers 200 with `readOnly: true`, because the pages it serves are still correct.

### `crombolo status`, for a deploy step

```sh
bunx crombolo status
```

```text
  site       My Site   /app
  database   postgres db:5432/my-site   reachable
  schema     files 1.1.0  database 1.1.0+4573   up to date
  framework  no migration pending
  content    112 document(s), 48 media, 9 element(s)
  email      resend
  findings   0 blocking, 0 need a person, 3 automatic, 0 resolved
```

`status` describes the environment without starting it, and without changing anything; on SQLite it will not even create the file. It exits with code 20 when something would stop the site working: an unreachable database, a migration waiting, or findings that need a person.

### `crombolo health`, for a monitor

```sh
bunx crombolo health
bunx crombolo health --group database
```

Runs the same checks as **Settings › Health Check** in the back office: the database, media storage, e-mail and the servers that have reported in. `--group` runs one group. It exits with code 20 when a check fails; a warning is reported but does not fail it.

## Pausing editing

When you need editors to stop saving for a while, to restore a backup or move the database, pause editing for the whole site:

```sh
bunx crombolo maintenance pause --reason "Restoring Monday's backup"
bunx crombolo maintenance status
bunx crombolo maintenance resume
```

The pause takes effect on every node at once. Editors who try to save are told the reason. Visitors are not affected, no node is taken out of service, and content imports still run, which is what lets a restore go ahead while editors wait.

## Backups

### Taken for you

Anything that changes the database in bulk takes a backup first: `upgrade`, `upgrade check --fix`, `content import`, `content revert`, `import`, `pull` into an existing site, `types purge` and `bundle purge`.

- **On SQLite** the backup is a copy of the database file beside it, named with the time and the reason.
- **On Postgres** crombolo runs the command in `CROMBOLO_PG_DUMP`. It is given `CROMBOLO_BACKUP_STAMP` and `CROMBOLO_BACKUP_REASON` to name the file with. Without the setting, these commands refuse unless you pass `--backup-taken` to say you have taken one another way.

```sh
CROMBOLO_PG_DUMP='pg_dump "$CROMBOLO_POSTGRES_URL" -f "/backups/$CROMBOLO_BACKUP_STAMP-$CROMBOLO_BACKUP_REASON.sql"'
```

### Routine backups

Those backups protect a single change. For routine backups, use the tools you would use for any database of its kind: your provider's snapshots or `pg_dump` for Postgres, and `sqlite3 crombolo.sqlite ".backup backup.sqlite"` for SQLite, which is safe while the site is running.

The database is not the whole site. Back up the media library too: the `media/` folder, or the bucket if you use one. Your schema, templates and config are in your repository.

### A portable copy

```sh
bunx crombolo export --site --out site-2026-10-17.tgz
```

A whole-site file holds the schema, templates, styles, every page and media item and the media files, in one file that `crombolo start --from` or `crombolo import` can bring back anywhere. It leaves out domains, the secret key and settings, and leaves out members and users unless you add `--with-members` or `--with-users`. It is a good way to move a site, and a useful extra copy, but it is not a replacement for a database backup.

## Rebuilding the cache

Each node keeps the published site in memory and refreshes it when content changes. If a node ever seems to be serving something stale, ask every node to rebuild:

```sh
bunx crombolo cache rebuild
```

Each node rebuilds within a few seconds, at its next check of the database. Only the database has to be reachable from where you run it.

## Rebuilding search

The search indexes live in the database, so one rebuild serves every node:

```sh
bunx crombolo index list                     # what each index holds, and what is waiting
bunx crombolo index rebuild                  # both indexes
bunx crombolo index rebuild InternalIndex    # just the back office's content index
```

Search keeps answering while a rebuild runs. `--queue-only` queues everything and leaves the indexing to the running site, which is kinder to a busy database.

## The recycle bin

```sh
bunx crombolo recycle-bin empty --older-than 30 --dry-run
bunx crombolo recycle-bin empty --older-than 30
```

Deletes what has been in the recycle bin for more than the given number of days, media files included. It asks first unless you pass `--yes`, and `--dry-run` lists what would go. `--content` or `--media` limits it to one bin.

## Logs

Log files are written to the site's `logs/` folder, one file a day, as structured JSON. The back office's **Log Viewer**, under **Settings**, reads them, so editors with access can search them without a terminal. Events are printed to the console too, for your platform to collect.

| Setting | Default | What it does |
| --- | --- | --- |
| `CROMBOLO_LOGS_DIR` | `logs` | where log files go |
| `CROMBOLO_LOG_LEVEL` | `info` | the least severe level logged: `trace`, `debug`, `info`, `warning`, `error` or `fatal` |
| `CROMBOLO_LOG_TO_CONSOLE` | `true` | print log events to the console as well |
| `CROMBOLO_TRACE_REQUESTS` | `false` | a console line as each request arrives and as it is answered, for diagnosing a node |

The audit log, which records who changed what, is kept in the database for a year by default (`CROMBOLO_AUDIT_RETENTION_DAYS`). A command run from a pipeline on someone's behalf can name them with `CROMBOLO_ACTOR`.

## Users and sign-in

When someone is locked out or has lost their authenticator, fix it from the command line:

```sh
bunx crombolo users list
bunx crombolo users unlock sam@example.com
bunx crombolo users reset-password sam@example.com
bunx crombolo users reset-2fa sam@example.com
bunx crombolo users disable sam@example.com
bunx crombolo admin reset-password
```

`reset-password` prints a generated password; with `--stdin` it reads one from a pipe instead, so it never sits in your shell history. On a site with no e-mail, `users invite <email> --group <alias>` creates the user and prints the link they set a password with. The [users commands](/docs/reference/command-line/users/) have the full list.

## Where next

- [The operations commands](/docs/reference/command-line/operations/), with every flag
- [Deploying](/docs/guides/deploying/): upgrades and running several nodes
