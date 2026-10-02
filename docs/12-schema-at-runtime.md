# Schema at runtime

How metadata changes made on a running site survive, reach every node, and get
back into source control — without a CMS user meeting git.

This is the tension Umbraco has never resolved cleanly: what an editor may change
against what a developer owns. Schema-as-code answers it by making developers own
it, which is safe and leaves editors waiting on a deploy for a new field. What
follows moves the line without giving up the guarantees.

## What was in the way

Three things, each deliberate on its own:

**The files were a projection of the database.** `schema-files.ts` writes by
calling `exportSchemaSet(db, …)` — it derives canonical TOML *from the database*
after the database has been written. Two writers, and the file always lost.

**A deployed site had nowhere durable to write.** `schemaWritable` defaults to
`NODE_ENV !== 'production'` because a container's disk does not survive a
redeploy. Without that guard a save looks like it worked and is reverted on the
next deploy, when `syncSchemaAtBoot` re-applies the image's files.

**Nothing re-read the files after boot.** `CacheInstructionPoller` compares this
node's boot-time state against the database and sets `behind`, which takes the
node out of the load balancer. That is an *upgrade* model — "this node is stale,
deploy a new one" — not a live-sync one.

## The shared schema store

`schemaStore` on `BunbracoConfig`, following `mediaStore`: absent means `schema/`
is a directory, which is what a repository checkout wants. Present — from
`s3SchemaStore` or `azureSchemaStore` — the store is the truth.

It is **materialised into a local directory at boot**, and everything downstream
carries on against files exactly as before. `loadSchemaDirectory` is synchronous
and used by the boot path, the sync, the validator and the CLI; making it async to
reach a network would have rippled through all of that for no gain. The local copy
is a cache, the store is the truth, and "the files are the schema" stays literally
true.

Materialising is a **mirror, not a merge**: a file the store no longer has is
removed locally, so a node restarting with yesterday's cache cannot resurrect a
deleted document type. Publishing back is a mirror in the same direction, and
skips unchanged files so that a `rewriteAll` — every file, after a move — does not
rewrite the whole bucket.

A store is any `MediaStore`: the same four verbs over the same key space, so the
S3 and Azure implementations serve both with nothing duplicated.

Configuring one turns `schemaWritable` on, because that is the point of
configuring it. An explicit setting still wins.

## Importing at runtime

`importSchema` applies the files to the database while the node is running, which
is what makes the files the source of truth rather than a projection: a TOML
edited in a commit, published by another node, or written by the backoffice
arrives the same way, through one path.

It re-materialises the store first, runs the same check that gates an upgrade, and
then syncs. On success it refreshes `nodeState` **in place** — the poller,
`/health` and the published-content source all hold that one object, and without
it a node that had just imported its own change would immediately judge itself
behind and drain.

Deliberately never automatic. It runs when somebody asks, or when an operation
needs it, because importing a half-finished schema underneath an editor mid-save
is worse than importing a minute later.

| | |
| --- | --- |
| `GET …/api/schema-import` | what it would do, changing nothing |
| `POST …/api/schema-import` | do it |

## The version moves by what the change costs

`compareStates` reads the version before the revision, so the version is how other
nodes learn they are behind. A production sync also refuses a changed hash at an
unchanged version — the guard that makes silent drift impossible. A change made
through the backoffice therefore has to move it, and the same check that gates an
upgrade decides how far.

| Classification | Version | Why |
| --- | --- | --- |
| `breaking` | **major** | a property's editor changed under live content |
| `data-requiring` | minor | newly mandatory property, or a migration to run |
| `additive` | minor | a new type or property |
| `none` | unchanged | nothing to apply |

**Classification happens before the database is written.** `runCheck` asks what
happens if these files are applied to this database; after a save the database
already holds the change, so there is nothing left to compare and every save would
classify as `none`. `schema-classify.ts` therefore asks the same questions of the
two aggregates a save has in hand — what the type is, and what it is about to
become — and the save path classifies first and saves second.

Removing a property is none of these. Properties are *retired* rather than
deleted, and their values come back if the property does, so the destructive case
is narrower than it looks: a data-type change under live content, or a type
removed while content still uses it.

## Getting it back into git

Optional. Configured with a `GitProvider`, the backoffice can show what the
repository is missing and send it.

A **pull request by default**: a schema change arriving as a PR is reviewable, one
arriving on `main` is not. `pullRequest: false` commits straight to the branch for
a site that would rather the repository simply mirrored reality.

Over the provider's HTTP API rather than a `git` binary — the CMS image has no git
and should not grow one, and a shallow clone per diff to compare a handful of TOML
files would be absurd. The commit is built the long way, from blobs to a tree to a
commit to moving a ref, so the whole change lands as **one commit**: that is what a
reviewer wants to see, and a partly-applied change is not a state that can happen.
A file the site no longer has is removed by giving its path a null sha, which is
how the tree API spells a deletion.

The token is the CMS's own identity, so commits are attributable to the CMS rather
than to whoever happened to be signed in.

## What this adds up to

An editor on a deployed site can add a field, and:

- the change is written to the shared store, so it outlives the container
- the schema version moves by what the change cost the content
- every other node picks it up at its next import
- a pull request carries the TOML to the repository for a developer to review

None of it is on by default. Without a schema store, schema stays a directory in
the image and a deployed site refuses to write it — which remains the right
default for a site whose metadata belongs to its developers.
