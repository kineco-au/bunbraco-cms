# 014 — Check, fix, upgrade

**Epic:** B — Packaging and upgrades · **Priority:** must · **Size:** L
**Depends on:** 013

## Story

As an operator, I want to see what a release needs from my content, fix what
can be fixed on the live site, and only then cut over, so that an upgrade
never meets a surprise in production and readers never see a maintenance page.

## Context

One check serves `upgrade check` and `schema check`, and it classifies the
whole change as additive, data-requiring, breaking or contract (see
[`../../packaging-and-upgrades.md`](../../packaging-and-upgrades.md), "Three
classes of change"). `check --fix` prepares everything it can under a
*prepared* state that live nodes cannot see. `upgrade` refuses until what is
left is clean, then cuts over.

**Decision:** value conversions run in `check --fix` and only there.
Append-only values make that safe, and it removes the editor pause. A value an
old node writes *after* the fix that still needs converting is a finding on
the next check, and `upgrade` refuses until `check --fix` has run again. This
was the maintainer's call, over the plan's original "convert the remainder at
upgrade".

## Acceptance criteria

- [x] **`upgrade_report`**, the stable shape the dashboard reads:
      `(id, run_id, kind: auto|person|blocking, code, subject_type,
      subject_key, subject_name, property_alias, culture, message, link,
      status: open|resolved, first_seen, last_seen, resolved_at)`. A run
      upserts by `(code, subject_key, property_alias, culture)` and marks
      anything it no longer reports `resolved`. *Renamed `change_report` by
      migration 018, with `source` and `scope` added, when content transfer
      began sharing it; see [`../../content-transfer.md`](../../content-transfer.md).*
- [x] **The check** (`packages/schema/src/check.ts`) covers pending framework
      steps (from the plan), the site diff (a dry-run sync report), and data
      findings over that diff:
      - a type removed with content → *blocking*
      - a new mandatory property on a type with documents → *auto* when the
        file declares `default` or `--set` names it, otherwise one *person*
        finding per document and culture, with the backoffice link
      - a property whose data type changed editor → the converter is run
        read-only over every current value: convertible → *auto*, failing →
        *person* per value, no converter → *blocking*
      - a reference (composition, allowed child, template) that resolves to
        nothing → *blocking*
- [x] **Converters**: one construct for site and framework.
      `defineValueMigration({ id, since, from: {type, property},
      to: [{property}], convert })` lives in `schema/migrations/*.ts`, loaded
      by the CLI from the site. Framework converters are the same objects in a
      registry keyed by editor alias. `convert` returns a value or throws; a
      throw is a *person* finding.
- [x] **`check --fix`**, in order:
      1. Take a backup.
      2. Sync under a *prepared* state.
      3. Append defaults, `--set type.property=value`, and every applicable
         value migration as `migrate` events under that state. Old nodes read
         as-of their own state and never see them.
      4. Record the run in the ledger.
      5. Re-run the check and write the report.
- [x] **`upgrade`**, in order:
      1. Take the content-tree and schema locks, and re-run the check.
      2. Refuse on *person* or *blocking* findings, including values left
         unconverted since the last fix. This applies under policy `strict`,
         the production default; development and test default to
         `pending-allowed`, and `--force` overrides and records who and why.
      3. Take a backup.
      4. Run the release's framework `contract` steps.
      5. `makeStateCurrent`, the cut-over.
      6. Write the ledger and a `cache_instruction`.

      Old nodes see the state advance on their next poll and switch to
      read-only. `/health` (non-contract) then answers 503 so the balancer
      drains them, and `server/status` reports the same.
- [x] **Development boot** syncs, then runs the check and writes the report. It
      does not stop; that is `pending-allowed`. **Production boot** never syncs
      a schema change with data findings: it refuses and names
      `upgrade check`.

## As built

Departures from the plan, recorded in
[`../../packaging-and-upgrades.md`](../../packaging-and-upgrades.md), Part 3:

- `upgrade` writes no content. Conversions run only at `check --fix`. A value
  an old node writes after the fix becomes an `unconverted-value` finding.
- A prepared sync defers three things to the cut-over, not one: an existing
  property's editor change, a property *becoming* mandatory, and every
  retirement. Old nodes therefore stay fully writable until `upgrade`.
- A node's *draft* reads are also as-of its own state. An unchanged value
  re-saved on an old node no longer overwrites a conversion: equality is judged
  against what the node sees, and the row superseded is the true current one.
- Live mandatory gaps on published pages are reported (`mandatory-unfilled`)
  for the dashboard, but never gate an upgrade.

Pinned by `tests/upgrade.test.ts`: both exit scenarios of 015, the policy,
`--set`, and an old instance through a cut-over.
