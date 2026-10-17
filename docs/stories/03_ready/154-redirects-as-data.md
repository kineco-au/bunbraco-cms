# 154 — Redirects as data

**Epic:** P — The command line · **Priority:** could · **Size:** S
**Depends on:** —

## Story

As someone relaunching a site, I want to load a spreadsheet of old URLs and
their new homes as redirects, and to export what the site already redirects, so
that search rankings survive the move.

## Context

Redirects come from two places (story 042): rules in `crombolo.config.ts`
(`redirect('/old-blog/*', '/news/$1')`, `operations.md`), and the URL tracker's
redirects, kept in the database and managed through `redirect-management`. A
migration usually arrives as a CSV of hundreds of one-to-one URLs: too many to
type into the back office, and a poor fit for config code.

## Acceptance criteria

- [ ] `crombolo redirects list` and `crombolo redirects export --out <file.csv>`
      cover both sources, each row marked with where it came from
- [ ] `crombolo redirects import <file.csv>` adds URL-tracker redirects: old URL,
      target (a URL, or a page's path or UUID), and an optional culture
- [ ] An import reports and skips loops, chains and rows whose target page does
      not exist, and `--dry-run` reports without writing
- [ ] Importing the same file twice changes nothing the second time
- [ ] Tests on SQLite and Postgres
