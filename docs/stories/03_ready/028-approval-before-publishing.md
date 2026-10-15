# 028 — Approval before publishing

**Epic:** C — The backoffice, end to end · **Priority:** should · **Size:** M
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

- [ ] An editor without publish rights can send a saved page (per culture) for
      approval; the page shows as waiting, with who sent it and when.
- [ ] Approvers are a user group named per site, optionally per branch of the
      tree; they see what is waiting in a dashboard and on the page itself.
- [ ] Approving publishes the version that was sent, not a later edit; a save
      after sending withdraws the request.
- [ ] Sending back records a comment, which the editor sees on the page.
- [ ] Each step is in the audit log, and approvers and the editor are e-mailed
      when a provider is configured.
- [ ] A scheduled publish can be sent for approval, and runs only once approved.

## Out of scope

- Multi-stage workflows with conditions. One stage of approvers per branch.
