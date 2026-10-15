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

- [x] A public interface for a field type covers its TOML settings, validation,
      the value it stores, its TSX rendering and its designer editor.
- [x] A public interface for a workflow type covers its settings, validation and
      the handler the queue runs, with the same retry semantics as the built-in
      three.
- [x] Both are registered through a server bundle; a definition naming a type no
      wired bundle provides is refused at validation, by name.
- [x] A fixture bundle adds one field type and one workflow type end to end:
      file, designer, render, submit, entry, workflow run.
- [x] The built-in types are unaffected and still refuse unknown settings.

## Out of scope

- Runtime installation of a server half (bundles never allow it).

## Decisions (2026-10-15)

- **Bundles on every node.** Every role creates the wired server bundles. Routes
  and tables stay backoffice-only, as now. A new `forms` hook, which carries field
  and workflow types, is honoured on every node, because forms render and submit
  on `web` nodes and workflows run wherever jobs run.
- **The type registry is passed in, never global.** Parsing and validating
  schema take the known form types as an argument, defaulting to the built-ins.
  So every call site (boot, the CLI, the form registry, status, Models Builder,
  sync) says which types it knows.
- **The designer's settings editor is generated** from each type's declared
  settings (name, label, kind and whether it is required), for the built-ins
  too. A bundle ships no browser code for its type.
- **A custom field type reuses a storage kind.** Its entry value is still
  `string[]` plus labels, so entries, the CSV export, redaction and workflow
  payloads are unchanged. It may add a `validate(values, settings)` that answers
  a message.
- **A workflow handler gets narrow capabilities:** the form, the values and
  labels, its settings, `fetch`, `sendEmail`, a logger and an abort signal. It
  never gets the raw database. It answers ok, or fail with or without retry; a
  throw is retryable. It gets the built-ins' 5 attempts with 1m/5m/15m/60m
  backoff.

## What was built

- **`packages/core/src/forms.ts`:**
  - Field and workflow type names are open strings; the built-ins are typed
    unions alongside.
  - `FormTypes` is the registry, and `BUILT_IN_FORM_TYPES` the default.
  - `FormSettingDeclaration`: each built-in setting now also has a declaration,
    which drives the designer.
  - Pure functions `formTypesWith` (merges a bundle's types, refusing a clash or
    a bad name) and `settingsProblems`.
  - `SchemaFormField.settings` holds a bundle type's own settings.
- **Schema:**
  - `parseForm`, `loadSchemaDirectory`, `validateForms`, `validateSchemaSet` and
    `syncSchema` take the types.
  - A field accepts a `settings` table.
  - The writer emits it inline.
  - An unknown type is refused by name.
- **`validateSubmission`** takes the types and runs a type's own `validate`.
- **`packages/render/src/forms.ts`:** `setFormFieldTypes` registers bundle
  renderers process-wide at boot, as the token signer is.
- **`packages/server/src/form-types.ts`, the public contract:**
  - `FormFieldTypeDefinition`, `FormWorkflowTypeDefinition`,
    `FormWorkflowRunContext` and `BundleForms`.
  - `collectFormTypes`, which is pure.
  - `formTypesOf` and `formTypesFor`, memoised per bundle list.
  - `describeFormTypes`, for the designer.
- **Server:**
  - `ServerBundle.forms`.
  - Bundles are validated on every node.
  - The types reach the form registry, form saves, the CSV export, Models
    Builder and every schema call site, the CLI included.
  - `runWorkflow` runs a bundle's handler with narrow capabilities, and fails
    an unknown type without retrying. Before, an unknown type returned
    `undefined`.
- **Designer:** the type list comes from `available-types`, shown by label, and
  a settings column is generated from each type's declarations.
- **Tests:**
  - `tests/forms-bundle-types.test.ts`, on both dialects. It uses the fixture
    bundle in `tests/support/form-types-bundle.ts`: a postcode field and a CRM
    hand-off posting to a local server.
  - Covered: the registry rules, settings checks, parse and validate with and
    without the bundle, the built-ins still refusing what they did, the designer
    listing and saving, render, submit validation, the entry, the hand-off and
    its retry semantics, and (on Postgres) a `web` node rendering the type.

## Not done

- There is no designer editor for workflows. The designer has never edited
  them, for the built-ins either; they are written in the file.

