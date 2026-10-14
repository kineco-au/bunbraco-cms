# 045 — E-mail delivery

**Epic:** E — Cross-cutting · **Priority:** must · **Size:** M
**Depends on:** —

## Story

As a site administrator, I want the site to send e-mail through a provider I
configure, so that invitations, password resets, form notifications and
content notifications actually reach people.

## Context

The roadmap's ranking listed e-mail first, as "no sender; only the
`sendUserLink` seam". **That is out of date.** Checked against the code on
2026-10-14, most of this has shipped.

- **The port.** `packages/server/src/email.ts` defines an `EmailPort`, with
  plain-`fetch` adapters for Resend, Postmark, SES (signature version 4) and a
  custom HTTP endpoint, plus a log adapter. All are exported from
  `@crombolo/crombolo` (`resendEmail`, `postmarkEmail`, `sesEmail`,
  `customEmail`, `logEmail`).
  - It is configured as `email` in `crombolo.config.ts` or
    `CROMBOLO_EMAIL_PROVIDER`.
  - There is no SMTP, by decision: outbound 25/587 is blocked on most container
    hosts.
  - `send` never throws.
- **What uses it.**
  - User invitations and password resets go through the port.
  - With no provider, they become *unavailable* rather than failing: invite
    answers `CannotInvite` with a message naming what to configure.
  - The Forms "Send email" workflow uses it too
    ([`forms.md`](../../forms.md)).
  - Pinned by `tests/email.test.ts`: adapters, availability, environment, boot
    notice, and what a site with and without e-mail does.
- **Not yet built.** The eleven content notification subscriptions are stored
  and never delivered. `packages/data/src/repositories/notifications.ts` still
  says sending them "needs e-mail, which the site does not have yet".

## Acceptance criteria

- [x] An e-mail port with HTTPS provider adapters, configured in the config file
      or the environment.
- [x] Invitations and password resets are sent through it, and are unavailable,
      with a reason a person can read, when no provider is configured.
- [x] The Forms "Send email" workflow sends through it.
- [ ] Content notification subscriptions are delivered: an action on a node
      (publish, delete, move and the rest of the eleven) e-mails the users
      subscribed to it, from a background job, once per cluster.
- [ ] With no provider, the notifications option is shown as unavailable rather
      than silently stored.

## Out of scope

- SMTP.
