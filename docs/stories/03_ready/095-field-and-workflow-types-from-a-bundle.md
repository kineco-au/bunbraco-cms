# 095 — Field and workflow types from a bundle

**Epic:** J — Forms · **Priority:** could · **Size:** L
**Depends on:** —

## Story

As a developer, I want to publish a form field type or workflow type as a
bundle, so that a site can add, say, an address lookup or a CRM hand-off without
a release of the CMS.

## Context

Field types are an internal registry on purpose: the TOML vocabulary, the
validator, the renderer and the entry shape must agree, and opening that
contract early was judged premature ([`../../forms.md`](../../forms.md),
"Field types"). The npm extension mechanism and server bundles
([`../../bundles.md`](../../bundles.md)) are where it goes when it opens. A
workflow type runs on the server, so it is a server-bundle concern: wired by an
import in `crombolo.config.ts`, never discovered.

## Acceptance criteria

- [ ] A public interface for a field type covers its TOML settings, validation,
      the value it stores, its TSX rendering and its designer editor.
- [ ] A public interface for a workflow type covers its settings, validation and
      the handler the queue runs, with the same retry semantics as the built-in
      three.
- [ ] Both are registered through a server bundle; a definition naming a type no
      wired bundle provides is refused at validation, by name.
- [ ] A fixture bundle adds one field type and one workflow type end to end:
      file, designer, render, submit, entry, workflow run.
- [ ] The built-in types are unaffected and still refuse unknown settings.

## Out of scope

- Runtime installation of a server half (bundles never allow it).
