---
title: Content transfer
summary: Move content between environments as a bundle of files, check what it would change, import it, and put it back if you need to.
order: 3
---

A deploy moves files: your schema, your templates, your config. It never moves content. When a campaign built on staging needs to reach production, or you want a copy of production's pages to develop against, you move the content as a separate, deliberate step.

crombolo does that with files. An export writes a **bundle**, the bundle travels however files already travel for you (a CI artifact, a commit, a bucket), and an import at the other end checks it and applies it. There is no connection between environments and no credentials for one stored in another.

## Bundles

A bundle is a folder that is also a private npm package. Each page or media item is one JSON file, keyed by its UUID rather than by a database id, so a bundle can be reviewed in a diff and means the same thing in every environment.

```text
bundles/campaign/
├── package.json        names the bundle
└── content/
    ├── bundle.json     the manifest, with a hash over everything else
    ├── nodes/          one file per page, element or media item
    ├── values/         property values, with --include-content
    └── blobs/          media files, with --with-blobs
```

A bundle carries the content and names the structure it needs: the content types, templates and languages. Your deploy has already put the same `schema/` in both environments, so the import only has to confirm they are there.

The same format carries more. A bundle built in the back office's **Bundles** section can also carry schema, templates, styles and scripts, so it installs into a site that has none of them. Starter templates bring their content this way, and so does a whole-site export.

## Exporting

```sh
bunx crombolo content export --root "/Campaigns/Autumn" --out bundles/campaign
```

`--root` takes a page by its path or its UUID, and can be repeated. The export takes the page and everything below it (`--only` takes just the page), and records what the destination must already have: a parent, or a page that a link in the content points at.

A bundle holds what the site serves. A published page carries its published values; a page that was never published carries its draft and says so. `--drafts` takes the latest draft of everything, for moving work in progress.

### What is readable and what is sealed

By default a bundle places and names pages but carries no property values, so it is safe to commit anywhere. To move the content itself:

```sh
bunx crombolo content export --root "/Campaigns/Autumn" --include-content --with-blobs --out bundles/campaign
```

`--include-content` adds property values, and `--with-blobs` adds the media files. Both are encrypted under a passphrase, which you are asked for or can give in `CROMBOLO_BUNDLE_PASSPHRASE`. The structure, names and schema stay readable for review. `--allow-content-unencrypted` writes the values in the clear, if you need to.

Members and back-office users travel only when asked for, with `--with-members` and `--with-users`, and always encrypted.

### What travels with a page

Beyond its values, each page carries its rules: who may see it, any publish or unpublish waiting for its time, and the redirects from addresses it used to have. They are re-created once every page in the bundle exists.

Nothing that belongs to one environment ever travels: domains, sessions, sign-ins, or anything in the recycle bin.

## Checking

Before anything is written, see what the import would do:

```sh
bunx crombolo content check bundles/campaign
```

`content check` changes nothing. It reports how many items would be created, updated or left alone, and sorts anything worth knowing into three kinds:

| Kind | Means | What to do |
| --- | --- | --- |
| **Blocking** | the site cannot take the bundle as it stands, such as a missing content type or parent | deploy the missing schema, or place the bundle elsewhere with `--under` |
| **Needs a person** | importable once someone decides, such as a page edited here since | answer it |
| **Automatic** | what the import will do, said out loud | nothing |

### Answering

Each decision is `take-bundle`, `keep-local` or `skip`, for a whole page or for one property:

```sh
bunx crombolo content check bundles/campaign --resolve 9a1f3c2e-…=take-bundle
bunx crombolo content check bundles/campaign --resolve 9a1f3c2e-…/title=keep-local
bunx crombolo content check bundles/campaign --resolve-all take-bundle --save
```

`--save` writes the answers into the bundle, so a decision made once on staging goes with the bundle to production rather than being made again. The findings also appear in the back office, on the **Changes** dashboard.

`content check` exits with code 21 while anything needs a person, so it can gate a pipeline.

## Importing

```sh
bunx crombolo content import bundles/campaign
```

The import checks again, takes a backup, and writes everything in one transaction, so a failure leaves nothing behind. On Postgres it needs `CROMBOLO_PG_DUMP` or `--backup-taken`; see [Operations](/docs/guides/operations/).

Pages arrive as drafts, for someone to review and publish. Media is live as soon as it lands. To publish what was live where the bundle came from:

```sh
bunx crombolo content import bundles/campaign --publish --label "autumn campaign"
```

Values are laid over what is there, so a bundle carrying a page's title cannot empty its summary. Importing the same bundle twice writes nothing the second time.

Going live can also be a step of its own:

```sh
bunx crombolo content publish "/Campaigns/Autumn" --descendants
bunx crombolo content publish "/Campaigns/Autumn" --at 2026-11-01T09:00
```

## Putting it back

Every import is recorded as a run, and every run can be undone:

```sh
bunx crombolo content runs
bunx crombolo content revert 5192ca80-…
```

A revert puts the site back to what it served: values and published state are restored, and pages the import created are unpublished and moved to the recycle bin, never deleted. If someone has edited a page since, the revert asks first; `--resolve-all discard` goes ahead. A revert is a run too, so it can itself be reverted.

## The dictionary

The dictionary stays in each environment's database, because translators work on the live site. Move it on its own:

```sh
bunx crombolo dictionary export --out dictionary.udt
bunx crombolo dictionary import dictionary.udt
```

## A whole site

To move everything, schema and templates included, use a whole-site file:

```sh
bunx crombolo export --site --out site.tgz
bunx crombolo start --from site.tgz            # in an empty folder: a new site, running
bunx crombolo import site.tgz --replace        # or replace an existing site
```

`import` says what would change before it changes anything. `--replace` moves what the file lacks to the recycle bin and keeps this site's people; `--replace-all` deletes it, and asks you to type the site's name first. Domains, the secret key and settings always stay as they are.

To move a whole site to and from a running site without handling the file yourself, see [Remotes](/docs/guides/remotes/).

## Where next

- [The `content` commands](/docs/reference/command-line/content/), with every flag
- [The `import` commands](/docs/reference/command-line/import/), for whole-site files
