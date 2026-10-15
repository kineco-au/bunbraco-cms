# 029 — Scheduled publishing through approval

**Epic:** C — The backoffice, end to end · **Priority:** could · **Size:** S
**Depends on:** 028

## Story

As an editor under an approval workflow, I want to say when the page should go
live (or come down) as I send it for approval, so that an approved change
publishes at the agreed time rather than the moment the last approver clicks.

## Context

Story `028` publishes when the last stage approves, and refuses a scheduled
publish of a covered page by someone who may not skip the workflow. Umbraco
Workflow's "Allow scheduling" setting lets a request carry a time. Scheduling
itself exists: `DocumentRepository.setSchedule` and the scheduled-publish job.

## Acceptance criteria

- [ ] A request can carry a publish or unpublish time, per culture, when the
      workflow allows it (a per-workflow setting).
- [ ] Approval writes the schedule instead of publishing; the job publishes at
      that time, and not before.
- [ ] A time that has passed by the time of approval publishes at once, and
      says so in the request's history.
- [ ] Approvers see the requested time, and may approve or send back; changing
      the time is a new request.
