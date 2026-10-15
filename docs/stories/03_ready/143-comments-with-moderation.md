# 143 — Comments with moderation

**Epic:** O — Building a site · **Priority:** could · **Size:** M
**Depends on:** —

## Story

As a site owner, I want visitors to comment on pages I choose, with comments
held for moderation and spam filtered, so that a blog moving from WordPress
keeps its conversation.

## Context

Forms already accept, store and protect visitor submissions (a honeypot and
timing in core, Turnstile as the escalation — [`forms.md`](../../forms.md)); comments are the same
machinery attached to a page and shown on it. Comments hold personal
information, so they follow form entries' retention (story `092`) and travel
sealed (story `071`).

## Acceptance criteria

- [ ] Comments are enabled per content type, open or closed per page, threaded
      to a configurable depth.
- [ ] New comments wait for approval unless the commenter has been approved
      before; members' comments carry their name.
- [ ] A moderation dashboard approves, rejects, marks as spam and replies, in
      bulk, with e-mail to moderators when a provider is configured.
- [ ] Spam filtering through the forms' protections, and a pluggable checker.
- [ ] Approved comments render through a component and the Delivery API, and
      are deleted on the schedule form entries use.
