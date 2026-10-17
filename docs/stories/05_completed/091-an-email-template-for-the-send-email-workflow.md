# 091 — An e-mail template for the send-e-mail workflow

**Epic:** J — Forms · **Priority:** should · **Size:** M
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

- [x] `template` on `sendEmail` names a component; the validator now accepts it
      and refuses a name no component answers to.
- [x] The component receives the form, the entry and its field values, and
      renders to HTML; a plain-text part is derived from it.
- [x] Sensitive fields are left out of every form e-mail — a template's props,
      the default body, `{alias}` substitution and attachments — unless the
      workflow opts in with `include-sensitive = true`.
- [x] A template that throws fails the workflow item on the retrying queue with
      a readable reason, and is retried like any other failure.
- [x] Without a `template`, the e-mail is as before, except that sensitive
      fields are left out unless the workflow opts in.
- [x] A template may declare a `layout`, as a page does, so one branded e-mail
      shell serves every form.
- [x] The forms designer can add, edit and remove a form's workflows, and the
      Send email workflow offers an "E-mail design" picker of the site's
      e-mail templates; what it saves passes the same validation as the files.

## Decisions

Taken on 2026-10-17:

1. **Sensitive fields are opt-in, per workflow.** `include-sensitive = true` on a
   Send email workflow sends them; without it they are left out of the
   template's props, the default body, `{alias}` substitution and the
   attachments. Today all of those include them, so forms with sensitive fields
   change: that goes in the release notes.
2. **Layouts are honoured.** `export const layout` works for an e-mail template
   as for a page; the layout receives the e-mail's props plus `children`.
3. **A template missing at send time is retried**, like any failure, and failed
   after five attempts with a readable reason: a node may still be catching up
   after a deploy.
4. **The forms designer gets a workflow editor now**, with an "E-mail design"
   picker for Send email.

Taken as recommended:

5. **Props:** the whole form, plus its fields flattened in the form's order with
   captions, values (labels first, as `{alias}` shows them) and whether each was
   left out, and `value(alias)`, the site's name and address, and the subject.
6. **The plain-text part is always derived** from the HTML.
7. **Rendering plugs in as a narrow capability** on the workflow runner
   (`renderEmail`), not by importing the renderer.
8. **The scaffold:** `crombolo components new <alias>` writes an e-mail template
   when a form's Send email names that alias, as it writes a page for a content
   type.
9. **`subject` stays a required setting.**

## Plan

### Rendering an e-mail

- `packages/render/src/email.ts`: `EmailProps` and `EmailField`, re-exported
  from `@crombolo/crombolo`, and a render scope with no page, so `useId` and
  `useContext` work and `usePage()` says "an e-mail template has no page; read
  what it needs from its props".
- `Renderer.renderEmail(alias, props)`: resolves the component in the current
  snapshot as a page's is, applies the render timeout and the layout chain
  (made generic over its props), and returns the HTML, or a missing component,
  or an error whose message names the alias and the line under `components/`,
  never a snapshot path.

### The workflow

- `form-workflows.ts`: `sendEmail` with a `template` renders it and sends the
  HTML with a text part from `htmlToText`. A render failure or a missing
  template fails the item with a readable reason, to be retried.
  `include-sensitive` decides, for every path, whether sensitive values are in.
  The stored error is readable, not a raw stack.
- `packages/server/src/email-text.ts`: `htmlToText` — paragraphs, headings and
  table rows as lines, list items as "- ", links as "text (url)", `head`,
  `style` and `script` dropped, entities decoded.

### Validation

- `template` is accepted on Send email when it is a safe component alias, and
  refused when no component answers to it (`componentAliases` moves into the
  forms validator's options, so boot, `types check`, bundle installs and the
  designer's save all check it). `body` with `template` is refused: the
  template writes the body. `include-sensitive` is a boolean.

### The forms designer

- A Workflows panel in `plugin/forms-overview.js`: the form's workflows listed
  by name and type, add, edit and remove, each with its settings as fields; for
  Send email, to, subject, reply-to, attach files, include sensitive answers,
  and an **E-mail design** picker listing the site's e-mail templates (from a
  new endpoint) with "Standard" for none. Saved through the existing form save,
  so the same validation answers, in plain words.

### Tests

`forms-schema.test.ts` (template accepted, unknown refused by path, unsafe
refused, `body` with `template` refused); `forms-workflows.test.ts` (HTML and a
tag-free text part; props in form order with captions; a sensitive field left
out without the opt-in and included with it, in a template and in the default
body; a throwing template retried with a readable reason, then failed; a
missing template retried; a layout wraps the template; `usePage()` explains
itself; no template, no HTML); `email-text.test.ts`; `components.test.ts` (the
e-mail scaffold renders); a browser test choosing an e-mail design in the
designer and saving.

### Docs

`docs/forms.md` (the template, the opt-in, failures; the stale "nothing can send
email"), `docs/writing-components.md` (an e-mail template example, checked by
`docs-components.test.ts`), `docs/features.md`, release notes for the
sensitive-field change.

## What was built

See [`forms.md`](../../forms.md), "An e-mail template", and
[`writing-components.md`](../../writing-components.md), "An e-mail".

- **Rendering:** `EmailProps`, `EmailField`, `EmailLayoutProps` and
  `EmailRenderResult` in `packages/render/src/email.ts`, re-exported from
  `@crombolo/crombolo`. `Renderer.renderEmail(alias, props)` resolves the
  component in the current views, runs it under the render time limit inside
  its layout chain (`#renderLayouts` is now generic over its props, and the
  deadline is shared through `#withDeadline`), and never throws: it answers
  `ok`, `missing`, or `error` with "The e-mail template 'x' failed at
  components/x.tsx:LINE: message" — snapshot paths rewritten, no stack.
  `emailScope` in `context.ts` gives ids and context with no page, and
  `usePage()`/`search()` say "an e-mail template has no page; read what it needs
  from its props".
- **The workflow:** `sendEmail` with a `template` renders it through the narrow
  `renderEmail` capability on `WorkflowDeps` (wired in `server.ts` to the
  renderer, with `site` from the SEO site name or `siteName`, and
  `applicationUrl`), and sends the HTML with `htmlToText` as the text part.
  `emailTemplateProps` builds the props; `leftOutFields` decides, for every path,
  which sensitive fields are emptied. A missing or throwing template is retried
  on the existing backoff and failed after `MAX_WORKFLOW_ATTEMPTS`. The subject
  is trimmed after substitution, so an emptied `{alias}` at the end leaves no
  trailing space.
- **Text part:** `htmlToText` in `packages/server/src/email-text.ts`, decoding
  with `decodeEntities`, now exported from `packages/data/src/search-text.ts`
  (which also stopped throwing on a numeric entity past the last code point).
- **Validation:** `componentAliases` moved into `ValidateFormsOptions`
  (`ValidateOptions` is now an alias of it), so boot, `types check`, bundle
  installs and the designer's save (`FormFileOptions.componentAliases`) all hold
  `template` to a component that exists. A template that is not a safe path, a
  `body` beside a `template`, and a non-boolean `include-sensitive` or
  `attach-uploads` are refused. The required-setting message is now plain "is
  required" (the path names the setting), since the designer shows it.
- **Designer:** a Workflows box in `plugin/forms-overview.js` lists the form's
  workflows (name, what it does, when it runs), adds, retypes and removes them,
  and draws each type's settings as fields; the operations are pure functions in
  `plugin/forms-workflows.js`. Send email has to, subject, reply-to, attach
  uploaded files, include sensitive answers, and the "E-mail design" picker fed
  by `GET <backoffice>/crombolo/api/forms/email-templates` (`listEmailTemplates`
  in `components.ts`). A refusal names the workflow and field in words.
- **Scaffold:** `emailScaffold` in `components.ts`; `crombolo components new`
  writes it when a form's Send email names the alias, and reports `email: true`.
- **Tests:** `tests/forms-schema.test.ts` ("an e-mail template"),
  `tests/forms-workflows.test.ts` ("sendEmail with a template"),
  `tests/email-text.test.ts`, `tests/forms-designer-workflows.test.ts`,
  `tests/components.test.ts` (the scaffold renders; the picker's list),
  `tests/cli.test.ts` ("components new"), `tests/docs-components.test.ts` (the
  guide's e-mail renders and type-checks), and the browser test
  `tests/browser/forms.browser.ts` choosing an e-mail design and saving.

### Decisions made while building

- **What the picker counts as an e-mail template:** a component whose source
  names `EmailProps`, plus any alias a form already names. Nothing turns on the
  folder, as elsewhere; a layout (typed `EmailLayoutProps`) is not offered.
- **A left-out field in the default body** reads "(sensitive, not included)",
  so the reader knows there was an answer; in `{alias}` substitution it becomes
  empty rather than staying as written.
- **`submittedAt`** is when the run was queued: the submission, or the approval
  for an `on = "approve"` workflow.

## Release notes

- **Sensitive answers are no longer e-mailed by default.** A Send email workflow
  now leaves fields marked `sensitive` out of the e-mail — the default body,
  `{alias}` substitution in its settings, a template's props and the attached
  uploads — unless it sets `include-sensitive = true`. A form that relied on
  e-mailing a sensitive answer needs that setting.
- **E-mail templates:** `template = "emails/receipt"` on a Send email workflow
  sends a TSX component under `components/` as the e-mail, with a layout if it
  declares one and a plain-text part derived from it. The forms designer can now
  edit a form's workflows, with an "E-mail design" picker.

## Out of scope

- Templates for invitation and password-reset e-mail.
