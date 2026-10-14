# 091 — An e-mail template for the send-e-mail workflow

**Epic:** J — Forms · **Priority:** should · **Size:** S
**Depends on:** —

## Story

As a site builder, I want the e-mail a form sends to use a TSX template I
write, so that it carries the site's branding and lays out the answers the way
the reader needs them.

## Context

`sendEmail` builds its body from the submitted fields, and the validator
**refuses a `template` setting by name** rather than accepting one that would
do nothing ([`../../forms.md`](../../forms.md), "Workflows"). The e-mail port
and its providers are built. Templates are TSX everywhere else in the CMS, so
an e-mail template is a component under `components/` rendered to a string,
with the same substitution values a workflow setting already has.

## Acceptance criteria

- [ ] `template` on `sendEmail` names a component; the validator now accepts it
      and refuses a name no component answers to.
- [ ] The component receives the form, the entry and its field values, and
      renders to HTML; a plain-text part is derived from it.
- [ ] Sensitive fields follow the same redaction rule as the entries view.
- [ ] A template that throws fails the workflow item on the retrying queue with
      a readable reason, and is retried like any other failure.
- [ ] Without a `template`, behaviour is unchanged.

## Out of scope

- Templates for invitation and password-reset e-mail.
