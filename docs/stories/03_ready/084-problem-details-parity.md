# 084 — Problem-details parity

**Epic:** I — Hardening · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As an editor, I want every error the backoffice shows to be the one Umbraco
would show, so that error messages make sense and the client never fails on an
error shape it doesn't expect.

## Context

Listed under Phase 7. The client renders `ProblemDetails` bodies and branches
on their `type`, `title` and operation status. A mismatch in an error shape is
the hard-to-diagnose failure risk R1 describes ([`roadmap.md`](../../roadmap.md)).

## Acceptance criteria

- [ ] Every error response is checked against the contract's declared error
      schema in test mode, as success responses are.
- [ ] Operation-status values and titles match Umbraco's for every operation
      that has one.
- [ ] A test enumerates every operation's declared error responses and fails on
      an undeclared status code or shape.
