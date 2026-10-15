# 028 — Approval before publishing

**Epic:** C — The backoffice, end to end · **Priority:** should · **Size:** L
**Depends on:** —

## Story

As an editor without the right to publish, I want to send a page for approval,
and as an approver I want to review, approve or send it back with a comment,
so that what goes live has been checked by someone allowed to say so.

## Context

Umbraco leaves this to Umbraco Workflow, a paid add-on; agencies moving from
Umbraco pay for it on sites that need sign-off. Having it in core is a reason to
move, not only parity.

- `Umb.Document.Publish` already separates those who may publish from those who
  may only save (`packages/core/src/permissions.ts`).
- Notification subscriptions and e-mail exist (story `045`); content
  notifications are not yet delivered, so approval notices go through the same
  e-mail port directly.
- The audit log (story `083`) records who did what, and is where the approval
  trail belongs.

## Acceptance criteria

- [x] Workflows are defined in `schema/workflows/` as an acyclic graph of
      stages, each naming its approver groups and where a send-back goes; the
      workflow names the branches and content types it covers, whether
      publishers may skip it and what an edit does while a page waits.
- [x] Admins draw a workflow on a canvas in the Workflows section — stages as boxes, arrows
      between them — and the canvas refuses a loop; it writes the file.
- [x] Stages with several arrows out run in parallel; a stage with several
      arrows in waits for all of them; the last approval publishes.
- [x] An editor the workflow does not let publish directly can send a saved
      page for approval from its Workflow tab; the page shows as waiting, with
      who sent it and when.
- [x] Only members of a stage's approver groups approve that stage; a stage is
      done when as many of them as it requires have approved (one, a majority,
      all, or a number).
- [x] Whether the person who made the change may approve it — refused,
      allowed, or counted automatically where they belong to the group — is set
      per workflow.
- [x] Approving publishes the version that was sent; an edit while it waits
      does what the workflow says (withdraw, approve the latest, lock from
      sending, or lock from the first approval). Administrators may always
      edit; their edit is recorded in the request's history.
- [x] A Workflows section lists what waits for the current user, the requests in
      flight, history and the workflows; a Workflow tab on a page shows which
      workflow applies, where the page stands in it, and its history.
- [x] What a request in flight does when its workflow is changed — finish under
      the version it started with, restart under the new one, or be withdrawn —
      is set per workflow, and the requests affected are named before the
      change is saved.
- [x] A workflow can cover unpublishing too: then "Request unpublish" goes
      through the same stages.
- [x] Whether a comment is required — never, when sending back, or always — is
      set per workflow. Sending back records the comment, and goes where the stage says: to the
      editor (the request ends), or to a named earlier stage (approvals after
      it are discarded and it runs again).
- [x] Each step is in the audit log, and approvers and the editor are e-mailed
      when a provider is configured.

## Out of scope

- Conditions on arrows. Every arrow out of a stage is followed.
- A publish time on a request: story `029`.
- Cycles. A loop is refused; sending back to an earlier stage is the only way
  round again.

## Decision (2026-10-15)

- **Approvers are named groups only.** Each stage names the user groups whose
  members may approve it. Publish rights alone do not make someone an approver,
  and a page under no workflow publishes as it does today.
- **A workflow is an acyclic graph of stages**, drawn on a canvas by an admin.
  Arrows out of a stage are followed in parallel; a stage with several arrows
  in waits for all of them (a join); when every last stage has approved, the
  page is published.
- **Each stage** names its `approvers` (user group aliases), how many must
  approve (`required`: `one`, `majority`, `all`, or a number), and its
  `send-back`: `editor` (the request ends, and the editor sends again from the
  start) or the alias of an earlier stage on its path (approvals from that
  stage on are discarded, and it runs again).
- **Each workflow** is configured with:
  - `applies-to`: branch roots by key and content types by alias. The most
    specific match wins: a branch beats a content type, and a nearer branch a
    farther one;
  - `publishers-may-skip`: whether someone with the publish right publishes
    directly, or must send for approval like everyone else — admins
    included;
  - `on-edit`: what saving a waiting page does — `withdraw` (the request is
    withdrawn, the editor sends again), `approve-latest` (the approvers
    approve what the page holds then), `lock` (refused until decided), or
    `lock-after-first-approval` (editable until someone approves);
  - `self-approval`: `refused` (the person who made the change cannot approve
    it), `allowed`, or `automatic` (a stage they belong to counts their
    approval as given);
  - `comments`: `optional`, `on-send-back`, or `always`;
  - `unpublish`: whether unpublishing a covered page also needs approval;
  - `on-change`: what a request in flight does when the workflow is changed —
    `keep` (it finishes under the version it started with), `restart` (it
    starts again from the first stage of the new version, its approvals
    discarded), or `withdraw` (it is withdrawn, and the editor sends again).
- **Administrators may always edit** a waiting page, whatever `on-edit` says;
  the request continues, the approvers see the latest, and the edit is in its
  history.
- **Where it shows** — as Umbraco Workflow arranges it, so people moving from
  it find their way: a top-level **Workflows** section (waiting for me, in
  flight, history, and the workflows, drawn on the canvas), and a **Workflow**
  tab on each page (which workflow applies, where the page stands in the
  graph, its history). Approvers are ordinary user groups, not a kind of
  their own.
- **Kept as schema files and in the backoffice**, as story `110`'s page-address
  options are: one TOML file per workflow under `schema/workflows/`, synced
  into the database like the rest of the schema; a Settings screen writes the
  files, and is read-only where the schema files are.

```toml
[workflow]
key = "4f0c…"
alias = "policy-sign-off"
name = "Policy sign-off"
applies-to = { branches = ["8a1e…"], content-types = ["policy"] }
publishers-may-skip = false
on-edit = "withdraw"          # withdraw | approve-latest | lock | lock-after-first-approval
self-approval = "refused"     # refused | allowed | automatic
comments = "on-send-back"     # optional | on-send-back | always
unpublish = true              # "Request unpublish" goes through the stages too
on-change = "keep"            # keep | restart | withdraw

[[stage]]
alias = "legal"
name = "Legal"
approvers = ["legal"]
required = "one"                 # one | majority | all | a number
next = ["brand", "compliance"]   # both run, in parallel
send-back = "editor"
position = { x = 0, y = 0 }      # where the canvas drew it

[[stage]]
alias = "brand"
approvers = ["marketing"]
next = ["final"]
send-back = "legal"
position = { x = 240, y = -80 }

[[stage]]
alias = "compliance"
approvers = ["compliance"]
next = ["final"]
send-back = "editor"
position = { x = 240, y = 80 }

[[stage]]
alias = "final"                  # waits for brand and compliance
approvers = ["directors"]
required = 2
next = []                        # last: approving publishes
send-back = "legal"
position = { x = 480, y = 0 }
```

- **Who approves can change in production.** Where the schema files are
  read-only, the workflows are too; the people in each approver group are
  ordinary user-group membership.

## Plan

1. **Workflow files** (`packages/schema`): model, parser, writer, validation
   — known groups, branch keys and content types; stage aliases unique; the
   graph acyclic, with one start; every `send-back` stage an ancestor of its
   stage; at most one workflow per branch root or content type — sync into the
   database, `schema check` findings; `crombolo schema new workflow`.
   The graph rules are pure functions shared with the canvas.
2. **Requests** (`packages/data`): migrations for `approval_request` — node,
   cultures, what is asked (`publish` or `unpublish`), the event that was
   sent, workflow key and the version of the workflow it started under, state
   (`waiting`, `approved`, `sent-back`, `withdrawn`), who and when — and
   `approval_step`, one row per stage reached, and `approval_decision`, one
   row per approver's decision with its comment. A stage becomes waiting when
   every stage with an arrow into it is done, and done when its `required`
   count is met. A repository of pure
   functions; `DocumentRepository` gains publishing a given event rather than
   the head, which approving needs.
3. **The gate** (`packages/server`): which workflow covers a page; publish,
   publish-with-descendants, unpublish (where the workflow covers it) and the
   scheduled jobs refuse a page whose workflow the caller may not skip, naming
   the workflow; save applies `on-edit`, except for administrators;
   `self-approval` and `comments` are enforced on each decision. Endpoints to send, approve, send back, withdraw and list what is
   waiting for the current user.
4. **The backoffice** (`packages/backoffice-host/plugin`): "Send for
   approval" and "Request unpublish" workspace actions where publishing or
   unpublishing directly would be refused; "Approve" and "Send back" for the
   approvers of a waiting stage; a Workflow tab on the page; a top-level
   Workflows section — waiting for me, in flight, history.
5. **The designer**: the workflows, in the Workflows section, on a canvas (an SVG
   editor with no new dependency, or a vendored graph library if one fits the
   backoffice's Lit elements) — add, move and connect stages, set each one's
   approvers, required count and send-back, and the workflow's settings;
   refuse an arrow that would make a loop, and save
   as the file, first naming the requests in flight and what `on-change`
   will do to them. The same graph, read-only, on a page's Workflow tab.
   A change that arrives as a file (a deploy, a bundle) applies `on-change`
   when it syncs, and records it in each request's history.
6. **Notices**: approvers e-mailed when a page is sent, the editor when it is
   decided, through the e-mail port when one is configured; every step in the
   audit log.
7. **Transfer**: workflow files travel in a bundle's `schema` section;
   requests never travel.
8. **Tests and docs**: the graph rules (cycles, joins, send-back targets);
   parallel stages and a join; each `required` count; send-back to the editor
   and to an earlier stage; each `on-edit` mode and an administrator's edit;
   each `self-approval` and `comments` setting; requested unpublishing; skip
   and no-skip; approving the sent version after later edits; each `on-change`
   setting with a request in flight; branch versus content-type matching;
   both dialects. `docs/workflows.md`.

Migrations: three tables, one new migration, so that sites already on a
published version (0.12.1 is on npm) get them on upgrade. Editing a shipped
migration instead was considered and rejected: those databases have recorded it
as run and would never get the tables. Its `release` must be the next version
(0.13.0), so `bun run release:version 0.13.0` comes first.

## Implementation

- **Model and graph rules** — `packages/core/src/workflows.ts`: stages, arrows,
  `workflowGraphProblems` (loops, one start, send-back to an ancestor),
  `stagesNowWaiting` (parallel stages and joins), `approvalsNeeded`,
  `workflowFor` (nearest branch, then content type).
- **The file** — `packages/schema/src/workflows.ts`: strict parser, canonical
  writer, `validateWorkflows` across the set, `workflowVersion` (positions left
  out). Loaded, validated and hashed with the rest of `schema/`; the hash is
  unchanged for a site with no workflows.
- **Sync** — a current schema sync stores the workflows in `key_value`
  (`crombolo:workflows`) and applies each changed one's `on-change` to the
  requests in flight (`syncWorkflows`, `packages/data/src/workflow-store.ts`).
- **Record** — migration 038 (`release: 0.13.1`; 0.13.0 was tagged and never published): `approval_request` (with the
  workflow copied onto it), `approval_step` (one row per stage visit),
  `approval_history` (each decision, edit, restart and outcome, with its
  comment); it gives Admin, Editors and Writers the Workflows section.
  `ApprovalRepository`.
- **Engine** — `packages/server/src/approvals.ts`: the gate (publish, branch,
  create-and-publish, unpublish, save before and after), sending, approving,
  sending back, withdrawing; `self-approval`, `comments` and `required`
  enforced per decision; publishing on approval through the document port after
  the transaction commits, a page that cannot be published going back to its
  editor with the reason; e-mail to approvers and the sender; an audit entry
  per step.
- **Gate** — `ApprovalGatePort`, asked by the document handlers; a refusal is a
  400 problem with `operationStatus: NeedsApproval` naming the workflow.
- **API** — `packages/server/src/approvals-api.ts` at
  `<backoffice>/crombolo/api/approvals/`: the page, send, approve, send back,
  withdraw, waiting, in flight, decided; the workflows, their preview (which
  requests a change affects) and save, writing the file and syncing at once.
- **Backoffice** — a Workflows section (Waiting for me, In flight, Decided, and
  Workflows for administrators: the list and the canvas designer), and a
  Workflow tab on every page; `packages/backoffice-host/plugin/workflow-*.js`.
  Sending, approving and sending back are buttons on the tab rather than in the
  workspace's action bar.
- **Tests** — `tests/workflows.test.ts` (graph rules and file),
  `tests/approvals.test.ts` (the gate, parallel stages and a join, send-backs,
  each setting, the designer's preview and save, a restart in flight),
  migrations and upgrade-from-release rewound to 0.12.1, and the manifest list.
- **Docs** — `docs/workflows.md`.

### Limits

- The tab sends the whole page; a request for some cultures only is possible
  through the API (`cultures`) and not offered on the tab.
- A restart applied by a sync does not count an `automatic` approval until the
  request is next acted on.
- A publish time on a request is story `029`.

