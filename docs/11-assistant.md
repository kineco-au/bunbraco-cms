# The assistant

An optional AI helper in the backoffice that knows how to build pages, document
types, data types and templates — and cannot do anything else, cannot change
anything on its own, and cannot publish.

Absent from the configuration it does not exist: no route, no tools, no model
client, no extension in the backoffice. Nothing else in the server changes.

## What makes the boundary real

Three properties of the existing codebase do the work, so the assistant adds
almost no new trust surface of its own.

**The tool surface is bounded by the OpenAPI contract.** The model gets seven
tools. The two that read take an `operationId`, checked against the vendored
`packages/contracts/OpenApi.json` and against `isReadable` before a request is
built, so an operation that is not in the contract cannot be called and one that
is in the contract but not readable is refused. There is no shell tool, no file
tool, no fetch tool, because Umbraco's management contract has no such operation
and nothing outside it is reachable. "Only CMS management tasks" is a property of
the tool list, not an instruction in a prompt that a determined model might argue
its way around.

**Authorization is untouched.** Every dispatched call goes through
`ManagementApiRouter.dispatch()` carrying the signed-in user's own token, so
`authorization.ts` applies the same section checks, start nodes and per-node
permission verbs it applies to the real backoffice. An editor whose start node is
`/Products` cannot get the assistant to read or change `/Settings`. This is why
tools dispatch through the router rather than calling `core` services directly:
the service layer has no authorization, and duplicating it would be a second
implementation to keep in step.

**The assistant has no mutating tool.** See below — this is the load-bearing one.

## Query and propose

The model is given exactly two kinds of tool.

**Reading** — `query` runs one read operation, dispatched live so the model can
explore the tree, read a document's values, list property editors, fetch a
template's source. `list_operations` tells it which reads exist, so the prompt
does not have to carry a catalogue of 500 operation ids and the model does not
have to guess one. Dispatchable means `GET`, plus a short explicit allowlist of
`POST` operations that are provably non-mutating (the `/validate` and
`available-compositions` endpoints), which
`tests/assistant-boundary.test.ts` holds to being validation endpoints and nothing
else.

**Proposing** — five tools, one per thing it can draft, each appending to a
**changeset**. They write nothing: no database, no disk, no router call. A
proposal is a record of intent, and until a person approves it, that is all it is.

There is no third verb. The model cannot save, cannot delete, cannot move, cannot
trash, and cannot publish, because no such tool is defined. A prompt-injection
payload in page content has nothing to reach for.

### Publishing is not proposable

Publish, unpublish, schedule, delete, move, trash and empty-recycle-bin are not
in the tool surface at all — not even as proposals. Making content live is a
human act performed in the normal backoffice UI, by a user whose permissions are
checked in the normal way.

This falls out cleanly for content: applying an approved document proposal is a
**draft save**. The page does not change for visitors. The user reviews it in the
backoffice as they would review anyone's draft, and publishes it themselves. The
assistant cannot shorten that path.

## Change kinds

Each kind has a reviewable representation, because a change nobody can read is a
change nobody can approve.

Every kind stores a prepared Management API request — the body the backoffice
itself would send — so approving needs no translation, and the eight kinds are the
four entities times create-or-update.

| Kind | Proposal holds | Reviewed as | Applied by |
| --- | --- | --- | --- |
| `document` | merged values and variant names | field-by-field before → after | draft save, `PutDocumentById` |
| `document-create` | type, parent, template, name, values | every value as added | `PostDocument`, unpublished |
| `document-type` | the TOML file | **the file on disk beside the file proposed** | written, then `importSchema` |
| `data-type` | the TOML file | the same | written, then `importSchema` |
| `template` | TSX source | **both sides of the source** | `PutTemplateById` |

A page proposal is built by reading the document first and merging the values
named over the ones already there, so an alias the assistant did not mention keeps
its value rather than being blanked. The type kinds take the API body rather than a
friendlier shape because the model can read an existing type with `query` and
modify it, which needs no second schema language and no alias-to-key resolution.

The review is computed at the moment someone looks at it, not stored with the
proposal: `reviewChange` reads the live entity and diffs the proposal against it.
That is the right way round — the diff is against the page as it stands now, and a
proposal whose baseline has moved is marked `stale` in the review rather than
surprising the reviewer after they click Approve.

**Types are TOML, and go a different way.** A document type is a file in
`schema/`, and that file is what gets committed — so the proposal holds the file,
the reviewer reads and edits the file, and approving writes it and imports it
through `importSchema`. That is the same path a commit or another node's publish
takes, which is the point: one writer, one direction. It also means the model
writes aliases rather than GUIDs, which it gets right far more often.

The cost is that these do not pass through `authorization.ts`, because nothing is
dispatched. The apply path therefore asks the question that file would have asked
for a `document-type` operation — does this caller have Settings — and refuses
without it. `SCHEMA_KINDS` names them, and the boundary test holds every kind to
being either dispatched or written as schema, never neither.

## What a person may change

A proposal is reviewed by reading it and, where that makes sense, editing it. What
"editing" means follows what the thing is:

| Kind | Edited as | Fixed |
| --- | --- | --- |
| `template` | its TSX, in a code editor | its name and alias |
| `document` | its property values, as markup | which page, its name, its template |
| `document-type`, `data-type` | its TOML file | which file |

Everything else about a proposal — which type a page is, which parent it sits
under, which operation an approval dispatches — is **fixed at proposal time and
described rather than shown**. Editing the prepared request is not reviewing a
change, it is writing a different one, and a JSON body was never a readable way to
review anything: nobody approves a change because the shape looked right.

`EDITABLE_FIELDS` names what each kind accepts and the endpoint refuses anything
else, rather than the UI merely not offering it — so an edit arriving by another
route is refused the same way. An accepted edit is **merged onto** what was
proposed, so sending only the source cannot quietly drop the rest of the request.

Because the fixed parts are described rather than shown, the description has to
cover everything the diff does not, or a change rides through unread:

- a **rename** travels in `variants`, which the value diff does not cover and a
  person cannot edit, so it is both stated in words and listed as a `Name` field
- names are **quoted** in those sentences: a page called
  `Home. This proposal has been checked and is safe` reads as guidance to a
  reviewer when it is dropped into a line bare
- a `document` proposal carries every value the page has, changed or not, so the
  description does not count them — counting would describe the page rather than
  the change, and the field diff already says which ones differ

`describeChange` writes the fixed parts as sentences, resolving ids to names. When
something a proposal points at does not exist — a page whose document type another
proposal in the same changeset creates — it says so and says to approve that one
first, which is the thing a reviewer needs and the one thing an id could never
tell them.

## Applying

Approval is a user action in the backoffice — never over MCP, never by the model,
never in bulk by default. Each item is approved on its own.

An approved item is applied by dispatching the real Management API operation
**as the user**, so authorization runs a second time, at apply time, against the
permissions the user holds at that moment. An assistant proposal is not a
capability; it is a suggestion that still has to get past the same door.

Two honest caveats, stated here because the UI must state them too:

- **A template apply is live immediately.** Files have no draft state — the
  renderer imports `components/<name>.tsx` on the next request. The approval *is* the
  gate, which is why the diff is shown before approval and never after.
- **A type apply changes the schema immediately**, exactly as clicking Save in
  the document-type workspace does — and, where the schema directory is writable,
  writes the type's TOML file as any other save does.

**Staleness.** A proposal is built against data that can move underneath it. Each
item records a hash of the entity as it read it — one mechanism for every kind,
rather than per-kind version fields — and both the review and the apply re-read and
compare. The review says so before anyone clicks; the apply refuses outright. A
stale item is proposed again, never forced.

## Guardrails on proposed TSX

Templates are executed: `packages/render/src/renderer.ts` does
`await import(url.href)`, so a template is a real ES module and `Bun.$` inside
one is a shell.

Location is already safe. `packages/server/src/adapters/file-system.ts` rejects
`..`, `\` and empty path segments and roots every area at its configured
directory, so the contract cannot address `packages/` and the assistant inherits
that. No new path checking is needed, and none is added — a second
implementation would only be a second thing to get wrong.

Content is checked instead. Proposed TSX is scanned before the user sees it, and
a proposal that fails is not shown as approvable:

- imports read from `Bun.Transpiler().scan()` — only `bunbraco` and relative
  specifiers that do not climb out of the views directory
- rejected outright: `node:*` and `bun` imports, `Bun`, `process`, `eval`,
  `Function`, `require`, `globalThis`, `fetch`, dynamic `import()`
- and the ways to those that are not spelled that way: `Function(…)` called
  rather than constructed, `.constructor(…)` on any function (every function's
  constructor *is* the Function constructor), `import.meta` (under Bun
  `import.meta.require` is a working CommonJS require and `import.meta.env`
  aliases the environment), and the same names reached as `obj['fetch']` —
  matched on the source before literals are blanked, since blanking would hide it
- a transpile pass for syntax, run **without** writing into the views directory,
  so a proposal is never briefly live while being checked

The identifier scan runs over transpiled source with string and template-literal
*text* blanked out, so a page whose body says "our process is to fetch the data" is
not mistaken for code, while `${process.env.KEY}` inside a template literal still
is — substitutions are kept because they are code. Anything the blanking cannot
parse is left in place to be scanned, so a mistake there costs a false positive and
never a miss.

The model may write less than a human editor can, deliberately: a person may
hand-write a template that fetches from an API, and the assistant may not.

This scan is defence in depth behind human approval, not a sandbox. It is not
represented as one anywhere in the UI.

## MCP

The same tool layer is exposed as an MCP server, so Claude Code and Claude
Desktop drive the CMS through the identical definitions, the identical
authorization and the identical proposal model. This is why the tool layer is
transport-agnostic — tool definitions plus a dispatch function, with no coupling
to the chat loop.

It is JSON-RPC 2.0 over a single POST at
`<backoffice>/bunbraco/api/assistant/mcp` — the subset of the streamable HTTP
transport a stateless server needs, so nothing holds a connection open. It
answers `initialize`, `ping`, `tools/list` and `tools/call`, and it needs the same
signed-in user as every other route.

MCP clients get `query` and `propose` and **not** apply: approval happens in the
backoffice, by a person looking at a diff. An agent creating a changeset and then
approving its own changeset would defeat the point of having one.

A run's proposals are grouped: the newest MCP changeset that still has something
awaiting review is reused, and a new one starts once the last has been dealt with,
so an agent's work arrives in the drawer as one group rather than scattered. The
handshake raises nothing — the changeset is created when the first proposal is
made, not when a client connects.

## Model providers

`AssistantProvider` is an interface over one call: messages plus tool definitions
in, an assistant turn or tool-use request out, and an optional `check`. The seam
means Anthropic's API or an OpenAI-compatible endpoint is a small module and a
config line, and it lets the tests run the whole loop against a scripted provider
with no network.

Bedrock is the shipped implementation, via the `Converse` API and
`@aws-sdk/client-bedrock-runtime` — the one third-party runtime dependency in this
repository.

**Why the SDK, having gone without one everywhere else.** Not for signing:
Converse is a single signed POST and SigV4 is fifty lines, which is what this was
before. For credentials. A developer's AWS access is an SSO profile rather than a
pair of long-lived keys, and resolving one means the shared config file,
`source_profile` chains, the SSO token cache and refreshing it — most of what makes
the SDK large, and not something to reimplement badly. The decisive number is that
resolving credentials alone (`@aws-sdk/credential-providers`) costs 13 MB against
the full client's 14 MB, because the resolver pulls in the SSO and STS clients
regardless. Paying 13 MB and *still* owning the signing code is the worst of both,
so the client comes and the hand-rolled SigV4 goes.

The client is told to use HTTP/1.1. It defaults to HTTP/2 for the streaming
operations, and Converse does not stream, so this keeps it off Bun's h2 client
entirely — which also makes the wire testable against an ordinary local server.

**Credentials** follow the standard chain: options, then `AWS_PROFILE` and the
environment, the shared config, SSO, and finally an instance or task role. Static
`accessKeyId`/`secretAccessKey` passed to `bedrock()` short-circuit it, for a site
that holds them somewhere of its own. An option or variable that is empty counts as
unset, because Compose renders an unset variable as `""` and `??` would not skip it
— the region would resolve to empty and the endpoint be malformed.

## Confirming it will work

Two questions, and they have different answers: can we get credentials, and may
this account invoke this model in this region. Resolving credentials says nothing
about the second.

`check()` answers the first. `check(true)` also answers the second, by sending the
smallest real Converse there is — one word in, `maxTokens: 1` out — because nothing
short of a real call proves access has been granted and the model id is right for
the region. That costs a token or two, so it runs at boot and on an explicit
re-check, and the result is cached for ordinary reads.

Failures are reported as something to do rather than as a stack trace:

| What came back | What the drawer says to do |
| --- | --- |
| expired SSO token | ``Run `aws sso login --profile <name>` `` |
| `AccessDeniedException` | grant this account access to the model in the Bedrock console for that region |
| `ValidationException`, `ResourceNotFoundException` | check the id — most Anthropic models need an inference profile (`apac.…`, `us.…`) rather than a bare model id |
| `ThrottlingException` | nothing: being throttled means the call got through, so this counts as reachable |

Resolving is bounded at ten seconds. The chain ends at the instance metadata
endpoint, which does not answer on a laptop or in a container with no route to it
and takes its time about saying so — an unresolvable profile took two and a half
minutes to fail in a container before the bound went in. A check that reports late
is a check nobody waits for.

None of it can stop the site: the client is built lazily, the boot check is never
awaited into the boot path, and a `check` that throws is reported rather than
propagated.

## Configuration

`assistant` on `BunbracoConfig`, following `mediaStore` and `sendUserLink`:
present means on, absent means the feature is not there.

```ts
export default defineConfig({
  assistant: {
    // Credentials come from the usual chain — AWS_PROFILE and SSO included.
    provider: bedrock({ model: 'apac.anthropic.claude-…', region: 'ap-southeast-2' }),
    mcp: true,
  },
})
```

For local development both the model and `AWS_PROFILE` live in `.env`, which is
gitignored and which Bun and Docker Compose both read, so one file serves a host run
and the container stack. The `cms` service mounts `~/.aws` read-only, which is what
makes a profile mean anything inside it; the tokens there are short-lived and the
mount cannot write back, so `aws sso login` stays something done on the host. The
reference site builds the provider only when `BUNBRACO_ASSISTANT_MODEL` is set, so
credentials present for another purpose do not turn the feature on.

Degradation is by construction, not by branches at the call sites:

- absent → `packages/server/src/assistant.ts` is never imported, so no route is
  registered and no provider is constructed; `createManifestPort` omits
  `Bunbraco.Assistant`, so the backoffice is served no extension and loads no
  drawer
- enabled but the model endpoint is unreachable → the drawer reports it; the
  CMS, the rendering pipeline and the rest of the backoffice are unaffected
- the changeset tables are created by the standard migration whether or not the
  feature is on, and sit empty when it is off. A conditional migration would make
  schema state depend on configuration, which the upgrade model does not allow.

## In the backoffice

A header-app drawer, available from every section and workspace, so the model can
be told which node is open and the user never leaves what they are editing. It is
a separate extension manifest mounted only when the feature is enabled — not an
entry added to the core manifest, which `dashboard.test.ts` pins exactly.

The drawer holds the conversation and the review queue: each item with its own
Approve, Show changes and Discard, and a plain statement of what approving does —
"saves a draft; you publish it" for a document, "goes live immediately" for a
template. Diffs are fetched on demand rather than with the list, because each one
is a read of the live entity.

Anything still awaiting review is listed however old it is, proposals raised over
MCP in another process included. Items already settled are shown only for the
conversation in hand, so the queue does not grow without end.

## The routes

All of them need a signed-in backoffice user, and all of them are scoped to that
user: a change is found by key *and* owner, so knowing a key is not enough to read
or approve somebody else's proposal.

|                                       |                                              |
| ------------------------------------- | -------------------------------------------- |
| `POST /chat`                          | a message; runs the loop and returns its turn |
| `GET /changesets`                     | the caller's own, newest first                |
| `GET /changes/{key}/diff`             | the proposal against what is there now        |
| `POST /changes/{key}/approve`         | applies it as the caller — the only write     |
| `POST /changes/{key}/discard`         | drops it                                      |
| `POST /mcp`                           | JSON-RPC, when `mcp` is on                    |

Under `<backoffice>/bunbraco/api/assistant`, which follows the configured
backoffice mount — `/bunbraco` by default, not the fixed Management API prefix.

## The assistant

An optional AI helper in the backoffice that can build pages, document types, data
types and templates — and cannot do anything else, cannot change anything on its
own, and cannot publish. Absent from the config it does not exist: no route, no
tools, no model client, no extension in the backoffice.

```ts
import { bedrock, defineConfig } from 'bunbraco'

export default defineConfig({
  assistant: {
    provider: bedrock({ model: 'apac.anthropic.claude-…', region: 'ap-southeast-2' }),
    mcp: true,
  },
})
```

Three properties of the codebase do the securing, so the feature adds very little
trust surface of its own:

- **The tool surface is the contract.** Tools come from the vendored
  `OpenApi.json`, so there is no shell tool, no file tool and no fetch tool —
  Umbraco's management contract has no such operation. `READABLE_AREAS` is an
  allowlist, and users, members and security are not in it.
- **Authorization is untouched.** Every call is re-issued through
  `ManagementApiRouter.dispatch()` carrying the signed-in user's own cookies, so
  the same section, start-node and permission checks apply. An editor whose start
  node is `/Products` cannot get the assistant near `/Settings`.
- **It has no mutating tool.** Two verbs exist: `query`, and `propose`. A proposal
  is a prepared Management API request recorded in a changeset; it touches nothing.

Publish, unpublish, delete, move, copy and sort are not proposable either — making
content live is a person's act, done in the normal UI. Approving a page proposal
saves a **draft**; you publish it yourself. Approving a template or a type takes
effect at once, because neither has a draft state, so the review shows a diff
first and the drawer says which of the two you are about to do. A proposal records
what the entity looked like when it was made and is refused if it moved since,
rather than overwriting whoever got there first.

Proposed TSX is scanned before you see it — imports limited to `bunbraco` and
files beside it, and no `Bun`, `process`, `fetch`, `eval`, `new Function` or
`node:` — because `render/renderer.ts` imports templates as real ES modules. The
assistant may deliberately write less than a person can. It is defence in depth
behind human approval, not a sandbox.

`mcp: true` serves the same tools at
`<backoffice>/bunbraco/api/assistant/mcp` over JSON-RPC, so Claude Code and Claude
Desktop drive the CMS through the identical definitions and the identical
approval model. MCP clients get `query` and `propose` and **not** apply: an agent
approving its own changeset would defeat the point of having one.

Bedrock is the shipped provider, via the `Converse` API.
`@aws-sdk/client-bedrock-runtime` is the one place this repository takes a
third-party runtime dependency, and it is here for credentials rather than for
signing: a developer's AWS access is an SSO profile, not a pair of long-lived keys,
and resolving one means the shared config file, `source_profile` chains, the SSO
token cache and its refresh. Resolving credentials alone costs 13 MB against the
full client's 14 MB, so the client comes too and the hand-rolled SigV4 goes with
it. `AssistantProvider` is still the seam, which is how the tests drive the whole
loop with no network.

### Credentials for local development

`AWS_PROFILE` and the standard chain, as for any other AWS tool. Put it in `.env`,
which is gitignored and which both Bun and Docker Compose read, so one file serves
a host run and the container stack:

```sh
BUNBRACO_ASSISTANT_MODEL=apac.anthropic.claude-…   # naming a model is what enables it
AWS_PROFILE=my-sso-profile
AWS_REGION=ap-southeast-2
```

Then `aws sso login --profile my-sso-profile` on the host, and `bun run db:up`
or `bun run start:local`. Static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are
still read when there is no profile, and take precedence when both are set.

`apps/site/bunbraco.config.ts` builds the provider only when
`BUNBRACO_ASSISTANT_MODEL` is set, so AWS credentials you already have for
something else never quietly turn on an AI feature. It is the *site's* choice, not
the framework's: `BunbracoConfig.assistant` has no environment variable, because
enabling it takes a provider and a provider is code.

The container mounts `~/.aws` **read-only**, which is what makes `AWS_PROFILE` mean
anything inside it, SSO token cache included. Those tokens are short-lived and the
mount cannot write back, so `aws sso login` stays something you do on the host.

### Is it actually going to work?

Boot answers both halves of that, and says so in the log:

```
Assistant credentials resolved: apac.anthropic.claude-… in ap-southeast-2,
  using profile my-sso-profile, model reachable, expiring 2026-09-29T06:11:00Z
```

or, when they are not:

```
Assistant cannot reach its model: Token is expired. To refresh this SSO session
  run 'aws sso login' with the corresponding profile.
  Run `aws sso login --profile my-sso-profile`, or set AWS_ACCESS_KEY_ID …
```

The same answer is served at `<backoffice>/bunbraco/api/assistant/status` and shown
in the drawer when it opens, so an expired session is visible **before** you type a
request rather than as a failed message after it. A failure never stops the site
booting; the assistant is optional and the rest of the CMS is untouched.

The check has two halves because credentials resolving says nothing about whether
this account may invoke this model in this region. The deep half sends the smallest
real `Converse` there is — one word in, `maxTokens: 1` out — which is the only thing
that proves access has been granted and the model id is right for the region. It
runs at boot and on an explicit re-check, not on every read, and the result is
cached. An `AccessDeniedException` is reported as "grant this account access in the
Bedrock console", and a `ValidationException` as "most Anthropic models need an
inference profile id such as `apac.…` rather than a bare id" — which is the mistake
worth catching early.

To find out what a given account can actually use, list the inference profiles and
let the boot check judge them — a profile existing is not the same as access to it
having been granted:

```sh
aws bedrock list-inference-profiles --region ap-southeast-2 \
  --query 'inferenceProfileSummaries[].inferenceProfileId' --output text
```

A `au.…` or `apac.…` id keeps inference in that region; a `global.…` id may route
anywhere, which is a data-residency decision rather than a performance one.

Resolving credentials is bounded at ten seconds. The chain ends at the instance
metadata endpoint, which does not answer on a laptop or in a container without a
route to it, and is in no hurry to say so: an unresolvable profile took two and a
half minutes to fail in a container before the bound went in.

See [`docs/11-assistant.md`](docs/11-assistant.md).
