# 092 — Form entries are deleted on a schedule

**Epic:** J — Forms · **Priority:** should · **Size:** S
**Depends on:** —

## Story

As a site owner, I want form entries deleted automatically after a period I
choose, so that the site does not keep personal data longer than it needs to.

## Context

Entries are kept forever today, including entries whose definition file was
deleted ([`../../forms.md`](../../forms.md), "Entries"). Scheduled writes
already run as jobs on the owning node only, so retention is one more job.
Uploaded files belong to entries and must go with them.

## Acceptance criteria

- [ ] A form declares `retain-entries-days`; the validator refuses a
      non-positive value. A site-wide default applies to forms without one.
- [ ] A job on the owning node deletes entries, their values and their uploaded
      files once older than the period, in batches.
- [ ] Orphaned entries (definition deleted) follow the site-wide default.
- [ ] Each run is logged with how many entries it removed per form.
- [ ] The entries view says how long entries are kept.

## Out of scope

- Anonymising instead of deleting.
- Deleting one person's entries on request.
