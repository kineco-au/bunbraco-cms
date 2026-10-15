# Forms

Form building in core, not as an add-on. Umbraco Forms is a paid product; the
features below are the ones that matter, placed the way the rest of this CMS
places things.

The strategic point is not price. It is that **a form definition is structure**,
and structure lives in files here. Umbraco Forms stores definitions in the
database only — the file option was removed in v9 and the migration is explicitly
irreversible — so an Umbraco site cannot diff a form in a pull request, cannot
review a change to one, and cannot deploy a form with the code that renders it.
That is the same gap `schema/` closed for content types, and the same gap uSync
and Deploy exist to paper over.

## Placement

The rule from [`schema-as-code.md`](schema-as-code.md) decides it: what
changes a thing?

| Part | Changes with | Lives in |
| --- | --- | --- |
| Form definition — pages, groups, fields, validation, workflows | a deploy, or an editor on a site with a schema store | **Files** `schema/forms/*.toml` |
| Entries (submissions) and their state | a visitor submitting, an editor approving | **Database** |
| Entry values | the same | **Database** |
| Uploaded files | the same | the media store's blob space |

The obvious objection is that editors create forms in production, where
`schemaWritable` defaults off. [`schema-at-runtime.md`](schema-at-runtime.md)
already answered that: with `s3SchemaStore` or `azureSchemaStore` the store is the
truth, materialised locally at boot and published back on write. A form is created
in the backoffice and lands in the store exactly as a content type does.

Without a schema store configured, forms are developer-owned and read-only in
production — the same trade the rest of `schema/` makes, and the backoffice says so
rather than failing a save silently.

## The file format

**Built** — `schema/forms/*.toml`, parsed by `parse-forms.ts`, written by
`write-forms.ts` and validated by `validate-forms.ts`, all in
`@crombolo/schema`. `parseForm(writeForm(x))` equals `x`, which is what lets the
backoffice write a file somebody will read in a diff.

Same vocabulary as the other schema files: kebab-case keys, a `key` UUID for
identity so a rename is not a delete, and arrays of tables for the tree.

```toml
[form]
key = "9c4a7d1e-0001-4b2a-9f31-6d8e2c5a7b40"
alias = "contactUs"
name = "Contact us"
store-entries = true
requires-approval = false
submit-label = "Send"
message-on-submit = "Thanks — we'll be in touch."

[[page]]
caption = "Your details"

  [[page.group]]
  caption = "About you"
  columns = 2

    [[page.group.field]]
    key = "9c4a7d1e-0002-4b2a-9f31-6d8e2c5a7b40"
    alias = "email"
    type = "shortAnswer"
    caption = "Email address"
    mandatory = true
    mandatory-message = "We need an email address to reply"
    pattern = "^[^@\\s]+@[^@\\s]+$"
    pattern-message = "That does not look like an email address"

    [[page.group.field]]
    key = "9c4a7d1e-0003-4b2a-9f31-6d8e2c5a7b40"
    alias = "enquiryType"
    type = "dropdown"
    caption = "What is this about?"
    values = ["Sales", "Support", "Something else"]

    [[page.group.field]]
    key = "9c4a7d1e-0004-4b2a-9f31-6d8e2c5a7b40"
    alias = "orderNumber"
    type = "shortAnswer"
    caption = "Order number"
    sensitive = true

      [page.group.field.condition]
      action = "show"
      match = "all"
      rule = [{ field = "enquiryType", operator = "is", value = "Support" }]

[[workflow]]
key = "9c4a7d1e-0010-4b2a-9f31-6d8e2c5a7b40"
type = "sendEmail"
name = "Tell the team"
on = "submit"

  [workflow.settings]
  to = "enquiries@example.com"
  reply-to = "{email}"
  subject = "Contact form: {enquiryType}"
```

`{alias}` substitutes a submitted value, in `subject`, `body` and `reply-to`
alike. There is deliberately no `template` setting: a TSX e-mail template is not
built, and the validator refuses the key rather than accepting one that would
silently do nothing — so `body`, or the default summary, is what a workflow
sends today.

`condition` sits on the field, group or page it governs. `workflow.on` is the
state transition that triggers it, which is what makes an approval flow possible
without a second concept.

## Field types

**Built.** The fourteen below are built in. A server bundle can add more, and
can add workflow types too: see "Types from a bundle", below.

| Type | Stores | Notes |
| --- | --- | --- |
| `shortAnswer` | one string | `pattern`, `placeholder`, `maxlength` |
| `longAnswer` | one string | `rows` |
| `email` | one string | validated, and the default reply-to source |
| `number` | one number | `min`, `max`, `step` |
| `date` | one ISO date | `min`, `max` |
| `checkbox` | one boolean | |
| `dropdown` | one string | `values`, or a `source` |
| `singleChoice` | one string | radios over `values` or a `source` |
| `multipleChoice` | string array | checkboxes over `values` or a `source` |
| `fileUpload` | blob keys | `accept`, `max-size`; goes through the same value intake as media |
| `dataConsent` | one boolean | mandatory by default, and the text is the label |
| `titleAndDescription` | nothing | presentational |
| `richText` | nothing | presentational |
| `hidden` | one string | default value may be a substitution |

Password is deliberately absent: a form that collects a password is a form that
should not exist, and Umbraco only has it for legacy reasons.

### Types from a bundle

A server bundle wired in `crombolo.config.ts` can add field types and workflow
types through its `forms` hook (story `095`). The contract is in
`packages/server/src/form-types.ts`.

```ts
export const postcodeField: FormFieldTypeDefinition = {
  type: 'postcode',             // camelCase, unique across built-ins and bundles
  label: 'Postcode',
  stores: 'string',             // string | strings | number | boolean | none
  settings: [{ key: 'country', label: 'Country', kind: 'text', required: true }],
  validate: (values, settings) => …,   // a message when the value is wrong
  render: ({ field, values, id, name, shown }) => <input … />,
}

export const crmHandoff: FormWorkflowTypeDefinition = {
  type: 'crmHandoff',
  label: 'Hand off to the CRM',
  settings: [{ key: 'endpoint', label: 'Endpoint', kind: 'text', required: true }],
  validate: (settings) => …,
  run: async ({ values, settings, fetch, sendEmail, log, signal, attempt }) =>
    ({ ok: true }),             // or { ok: false, error, retry }
}

export const acmeForms = (): ServerBundle => ({
  id: 'acme-forms', section: 'settings', capabilities: [], routes: [],
  forms: { fields: [postcodeField], workflows: [crmHandoff] },
})
```

**In the file,** a bundle field keeps its settings in a `settings` table:
`settings = { country = "AU" }`. A bundle workflow uses `[workflow.settings]`, as
the built-ins do. Both are held to the declared settings: one it does not
declare, one it requires that is missing, or a value of the wrong kind is
refused by name. The type's own `validate` then runs. A built-in field still
refuses a `settings` table, and any setting that does not apply to it.

**A type no wired bundle provides is refused by name**, at boot, by `crombolo
schema check`, and in the designer: "the field type "postcode" is not built in,
and no wired bundle provides it". The known types are passed to the parser and
validator, never held globally, so every caller names the types it knows.

**The value is a built-in kind.** A bundle's field stores as `string`,
`strings`, `number`, `boolean` or `none`. An entry is still a list of strings
with optional labels, so entries, the CSV export, redaction and workflows read
it like any other field. `validate` runs after the kind's own checks, on the
server, on submit. If it throws, the field is refused, not the whole submission.

**It renders through the bundle.** The renderer draws the control, and the form
draws the label, help text and error around it, as it does for a built-in. A
site's own `components` override still wins.

**The designer edits its settings from the declarations,** and does the same
for the built-ins. A bundle ships no browser code. The designer reads the types
from `<backoffice>/crombolo/api/forms/available-types`.

**A workflow handler gets narrow capabilities:** the submission's values and
labels by alias, its settings, the attempt number, `fetch` and `sendEmail`, a
log named for the type, and a signal that aborts after a minute. It never gets
the database. It runs on the built-ins' queue, with the same retries: up to five
attempts, at 1, 5, 15 and 60 minutes. A throw counts as retryable. A run whose
type no wired bundle provides fails at once, without retrying.

**On every node.** A bundle's form types are honoured on `web` nodes too,
because forms render and submit there. Its routes and tables still belong to
the nodes that serve the backoffice.

### Choices from a source

A choice field can take its options from a list kept once, instead of carrying
its own `values` (Umbraco Forms calls this a prevalue source):

```toml
[[page.group.field]]
alias = "department"
type = "dropdown"
source = { kind = "content", parent = "6f1d4a8e-…" }    # a page's published children

[[page.group.field]]
alias = "region"
type = "singleChoice"
source = { kind = "dictionary", parent = "Regions" }    # a dictionary item's children
```

- **Each option has a key and a label.** The key is what is stored when it is
  chosen: the child page's key, or the dictionary item's key. The label is what
  a visitor sees: the page's name in the page's language, or the item's
  translation (its name when it has none). A rename therefore changes what new
  visitors read and not what earlier entries hold.
- **One resolution, three readers.** The published cache resolves a source
  (`resolveChoices`) into the field's `options`, so `<Form>`, the submission
  check and the designer's preview all read the same list. A form picked on a
  page resolves against that page's language; a submission resolves against the
  page it was sent from. A key that is not in the list *now* is refused.
- **An entry keeps the label.** `form_entry_value.label` (migration 034) stores
  what the visitor saw beside the key, so an entry still reads after the page or
  item is renamed or removed. Entry views, the CSV export and e-mail text show
  labels; `sendToUrl` and `saveAsContent` receive the keys.
- **The file stays the file.** `options` is never written; `parseForm(writeForm(x))`
  equals `x` with a source present.
- Only published children are offered, in their sort order. A parent that does
  not exist offers nothing rather than failing the page. Sources that call a URL
  are out of scope.

## Validation

**Built**, in `@crombolo/core` — not in the server, because it is a rule about
what a form means rather than about HTTP. **The server is the only authority.** The client gets the same rules and uses them
for immediate feedback, but every submission is re-validated from the definition
before anything is stored, and so is every condition — a hidden field's value is
discarded rather than trusted, because "hidden" is a client-side claim.

This is a deliberate divergence. Umbraco Forms leans on ASP.NET unobtrusive
validation and its conditional logic is a client-side concern tied to CSS classes.
Here conditions are evaluated twice and the server's answer wins.

## Entries

**Built.** Migration **023**, two tables, keyed by the form's UUID rather than a foreign key
to a definition row — the definition is a file, so there is nothing to point at.

```
form_entry        id, form_key, state, culture, created, updated,
                  ip_hash, user_agent, page_key
form_entry_value  entry_id, field_alias, value (text), sort
```

`state` is `submitted` | `approved` | `rejected`. A form with
`requires-approval = false` writes `submitted` and runs its submit workflows
immediately; one that requires approval waits, and the approve transition runs the
workflows bound to it.

`form_key` surviving the deletion of its definition file is intentional: the
entries are the business record and must not vanish because a developer removed a
form. The backoffice lists orphaned entries under the form's last known name.

**Sensitive fields** (`sensitive = true`) are stored normally and redacted on
read for anyone without the sensitive-data permission — redacted in the API
response, not in the UI, so the values never reach a browser that may not see
them. The same gate covers CSV export, which refuses rather than silently
exporting blanks.

`ip_hash` is a salted hash, not an address: enough to rate-limit and spot abuse,
not enough to be a personal-data liability by accident.

## What validation refuses

Beyond the per-file strictness every schema file gets, a form is checked against
itself and against the rest of the set. The rules worth knowing:

- **A condition may only look backwards.** A rule naming a field that comes
  later has no value to compare, so the answer would depend on which way the
  form is read. Refused, with the field named.
- **A presentational field is not a subject.** `titleAndDescription` and
  `richText` collect nothing, so they cannot be mandatory, sensitive, or
  compared in a condition — and a form made only of them collects nothing at
  all, which is a mistake rather than a form.
- **Settings belong to their type.** `rows` on a `shortAnswer`, `accept` on a
  `dropdown`: each is refused by name rather than ignored, because a setting
  that does nothing looks like one that works.
- **Choices and defaults agree.** A choice field needs values or a source, never
  both, and a plain field can have neither. A source's `kind` is `content` or
  `dictionary`, refused by name otherwise; a content source names its parent by
  key. A default must be one of the values or the form opens invalid — a source's
  options are only known when it resolves, so its default is not checked here.
- **A form must have an effect.** `store-entries = false` with no workflow means
  a submission does nothing; approval without stored entries has nothing to
  approve.
- **Workflow settings are per type**, required ones checked and unknown ones
  named. `saveAsContent` is held to a content type that exists and to the
  form's own field aliases, and a `pattern` has to compile.

A broken form file fails the boot, like any other broken schema file: the files
are the schema, so a site does not start half-configured. The message names the
file and the key.

## Workflows

**Built.** Three, each a function over the submission:

- **`sendEmail`** — through the email port. `to`, `subject`, `cc`, `bcc`,
  `reply-to`, `from`, `body`, `attach-uploads`. With no `body` it sends a plain
  list of captions and answers, which is what most forms want.
- **`saveAsContent`** — creates a document of `content-type` from `map` (field alias → property
  alias), named from `name-field`, under `parent`, published when `publish` is
  true.
- **`sendToUrl`** — POSTs JSON: `{form, formName, entryId, submittedAt, fields}`.
  `method`, `headers` and `include-standard-fields` are configurable.

No `template` setting on `sendEmail` yet. A TSX email template is not built, and
the validator **refuses the setting by name** rather than accepting one that
would silently do nothing. A template is story `091`.

### Substitution

`{fieldAlias}` in a workflow setting becomes what was submitted — and that is
all that is left of Umbraco Forms' magic strings. There, seven placeholder
syntaxes exist because Razor cannot reach into the record; a view here is TSX
and reads the model directly, so the only place substitution is needed is a
workflow's own settings. An unknown alias is left as written, so a stray brace
in a subject line reads as itself rather than vanishing.

Dropped from Umbraco's nine: **Post as XML**, **Save as an XML File** and **Send
XSLT Transformed Email** are 2010s integration shapes, and `sendToUrl` with JSON
covers what they were for. **Slack** is `sendToUrl` with a webhook URL, so it is a
documented recipe rather than a type. **Change Record State** becomes the
spam-handling and approval rules on the form, not a workflow a person wires up.

### The queue

Migration **024** (`form_workflow_run`): a row per workflow per submission, with
the submitted values on the row rather than read back from the entry — a form
may store no entries and still have workflows, which the validator insists on,
since a form that does neither has no effect.

The ordering is the point. **The submission is stored, then the workflows are
queued, then a job drains the queue** — so a mail server that is down for ten
minutes delays an email rather than costing an entry, and the request returns
before anything leaves the building.

Claimed with `UPDATE … WHERE state = 'pending' … RETURNING`, which is atomic on
both dialects: every node polls, exactly one wins each row. Without that, two
nodes would send the same email. Retried on a backoff — 1, 5, 15, 60 minutes —
and after five attempts left `failed` for a person to look at.

A failure is classified rather than retried blindly:

| Failure | Retried? |
| --- | --- |
| A provider refused, a 5xx, a dead network | yes — weather |
| A 4xx from `sendToUrl` | no — it will not fix itself |
| No email provider configured | no, and the error names what to set |
| A node behind the schema cannot write | yes — the deploy will finish |
| The form or the workflow is gone from the file | no, and the row says which |

**Spam queues nothing.** A workflow is an outbound effect, and firing one for a
submission already judged to be a bot is how a form becomes a relay. The entry
is still stored and flagged.

`on = "approve"` workflows are queued when an entry is approved, from the values
the entry holds — so the approval is what triggers them, and rejecting runs
nothing.

## The email port

Nothing in this CMS can send email today — `ports.ts:246` *logs* invitation and
password-reset links. Four of Umbraco's nine workflows are email, so this is a
prerequisite rather than a detail, and it fixes invites and password resets on the
way past.

```ts
interface EmailPort {
  send(message: EmailMessage): Promise<EmailResult>
}
```

**Built** — see [`configuration.md`](configuration.md#e-mail). Adapters over
plain `fetch`: `resendEmail`, `postmarkEmail`, `sesEmail` and `customEmail`. No
new runtime dependency, and no hand-rolled SMTP — outbound 25/587 is blocked on
most container hosts, so an SMTP client would be protocol risk in exchange for a
path that often cannot be used.

SES needs SigV4, so the signing is ours. It is checked against AWS's published
key-derivation example *and* against Bun's own SigV4, which signs the same
canonical request to the same bytes — two known answers rather than a hope.

The console stand-in is the development default, which keeps the test suite
offline, and reports as unavailable so nobody mistakes it for delivery. A site
with no provider has invitations, password resets and this workflow *unavailable
with a reason* rather than failing when someone presses the button.

## Rendering

**Built.** `<Form>` comes from `@crombolo/crombolo`, and a view is three lines:

```tsx
import { Form } from '@crombolo/crombolo'

export default function Page({ model, submission }) {
  return <Form form={model.value('contactForm')} submission={submission} />
}
```

`model.value('contactForm')` is a `formPicker` property, and the value converter
resolves the stored key to the definition — so a view gets the form, not a UUID.
`value()` is untyped, so a hand-written view casts it (`as SchemaForm | null`);
`crombolo generate` is what removes the cast.

The demo template is the worked example:
`sites/harbourstone/schema/forms/contact.toml` is pointed at by the
Contact page's `enquiryForm` property and rendered by `components/contactPage.tsx`. It
is also where the conditional-field rule is exercised: `company` appears only for
a trade enquiry, and the server discards its value when the condition does not
hold.

### Theming is composition, not directories

This is a **deliberate change from the plan above**, which described Umbraco's
theme folders — `components/Forms/<theme>/<fieldType>.tsx` with a fallback chain.
Two things made that the wrong shape here:

- A component renders synchronously, and a view cannot await. Loading theme
  modules would mean the renderer preloading every theme directory for the
  current generation and handing them down through a context — machinery whose
  only purpose is to do what a prop already does.
- Umbraco needs theme folders because Razor has no other way to substitute a
  partial. TSX does: pass a different function.

So `components` overrides the renderer for a field type, and a site that wants
different markup altogether writes it from the definition — `allFormFields(form)`
and whatever JSX it likes. `form.theme` becomes a class on the `<form>` element
(`crombolo-form crombolo-form--compact`), which is what a stylesheet actually
needs. Directory-based themes can be added later if composition turns out not to
be enough; nothing here forecloses it.

### What the markup is

A real `<form method="post">` that works with **no JavaScript at all**. Every
field is in the markup, including the ones the current answers hide: a hidden
field carries `hidden` plus its condition as `data-condition`, so a script can
reveal it without a round trip, and a visitor without one gets the server's
answer on submit. `multipart/form-data` only when the form has a file to carry.

Multi-page definitions render every page into one form, so a submission arrives
in one go.

**`step-pages = true`** shows one page at a time, in the browser (story `093`).
The form carries `data-step-pages`, and its Back and Next buttons render
`hidden` until the script reveals them. Behaviour you might not expect:

- **No round trip per page.** Every page stays in the one `<form>`, so earlier
  answers, uploads included, never travel between steps. Nothing is stored, and
  nothing waits on the server, until the final submission. That submission is
  checked in full, as for any form.
- **Next checks the current page on the server.** The script posts the form
  with `_crombolo_page=<index>`. The endpoint checks the token and that page's
  fields, against the answers on earlier pages so a condition on them holds. It
  judges an upload by its name and size and writes nothing. It never stores an
  entry or queues a workflow. It answers `200 { ok: true }`, or `422` with that
  page's errors, which the script shows on the page.
- **A page a condition hides is skipped** both ways, and a page closed while
  the visitor is on it steps back to an open one.
- **Enter on an earlier page means Next.** After a refused final submission,
  the form opens on the first page with an error.
- **Without JavaScript, every page shows at once** and the form is checked on
  submit, exactly as with `step-pages` off. The browser does the stepping, so
  no answer needs carrying through the server.

A form reaches a page through a `formPicker` data type — **built**, seeded with
the other built-ins so a property can use it with no file, and with its editor
UI in our own plugin rather than the vendored client — rendered by a `<Form>`
component from `@crombolo/crombolo`. Progressive enhancement is the baseline: the form is a
real `<form method="post">` that works without JavaScript, and the client script
adds conditional logic, inline validation and optional fetch submission on top.

### Submitting

**Built.** `POST /crombolo/forms/<formKey>`, outside the Management API because
the caller is the public.

Two answers, by what the client asked for:

| Client | Accepted | Refused |
| --- | --- | --- |
| `fetch` (`Accept: application/json`) | `200 {ok, message, entryId}` | `422 {ok: false, errors}` |
| A browser | `303` to the page, or to `redirect-to` | `303` back to the page |

The browser path is what makes this work without JavaScript: the endpoint
redirects back and the form reappears **inside its own layout**, with either its
errors and what was typed, or its thank-you. A redirect cannot carry a body, so
that state travels in a short-lived signed cookie, read once and cleared — a
reload shows the form again rather than the thank-you for ever.

**The token is not a CSRF token**, and does not pretend to be one: a public form
has no session to tie one to. It is an HMAC over `formKey|renderedAt`, and its
job is to make the timing guard mean something — without it a bot posts whatever
render time it likes and "too fast" is unenforceable. Signed with
`Bun.CryptoHasher` rather than `crypto.subtle`, because a template signs while
it renders and a view cannot await.

Uploads take the same two steps a media upload takes — `saveTemporary` then
`place` — so the safe naming, the content-type sniffing and the extension rules
are the ones the media library already has. `isUploadAllowed` enforces both
lists: the deny list is what keeps an `.aspx` out, and `allowedExtensions` is
empty by default, so checking only that would refuse everything.

## Spam

**Built.** Honeypot and timing in core: a field real users never fill, and a minimum elapsed
time between render and submit. Both are free, invisible, and need no third party.
`marked-as-spam` entries are stored and flagged rather than dropped, because a
false positive that silently discards an enquiry is worse than one to review.

Turnstile is the pluggable escalation when that is not enough. reCAPTCHA is
deliberately not built in — three variants of it is Umbraco carrying history, and
sending every visitor to Google is a decision a site should take knowingly.

## Backoffice

**Built.** None of this exists upstream to borrow. The vendored backoffice ships 44 packages
and Forms is not among them; `OpenApi.json` mentions "forms" twice, both about the
installer. Umbraco Forms' UI is a separate npm package, `@umbraco-forms/backoffice`.

That is freedom rather than a problem. Everywhere else the vendored contract is
the constraint — operation ids, response shapes, `overwrites` on core extensions.
Here there is no contract to match, so the API is designed for this CMS.

- A **Forms section**, registered from `backoffice-host/plugin/umbraco-package.json`
  as a `section` with a tree of forms, beside the sections the vendored client
  provides
- Operations under `${paths.pluginPath}/api/forms/*`, following the marketplace
  precedent from the packages work — outside the contract-first router, because an
  operation not in `OpenApi.json` has no place in it
- A **Forms section** (`Crombolo.Section.Forms`) with two views, Forms and Entries.
  The alias resolves now: Umbraco seeds the stored `forms` alias and then has no
  section for it, so `toSectionAliases` used to drop it
- The **designer** is a table, not a canvas. A form is a file, and what somebody
  edits here is written straight back to TOML, so the shape that matters is the
  one a diff shows. Saving sends the whole definition; the server writes it to
  TOML and **reads it back with the strict parser** before keeping it, so a
  refusal in the designer is the same refusal a hand-written file would get, and
  a rejected save never touches the file on disk.
- The designer edits the **layout** (story `094`):
  - Pages and groups can be added, renamed, reordered and removed. Removing one
    that holds fields asks first, and a form keeps one page and a page one group.
  - A group's columns (1–4) are set from a list, with a preview of the rows the
    form will lay out.
  - Fields reorder within a group and move between groups by dragging, or from
    the keyboard with each row's up and down buttons, which step across into the
    next group at an edge.
  - The operations are pure functions in `plugin/forms-layout.js`. The writer's
    order is the model's, so a reorder saves as a move: the same lines, in a new
    order.
- A choice field's options come from **typed values, a page's child pages
  (picked with the document picker) or a dictionary item's children**, and the
  designer shows what a source offers right now, from
  `POST <backoffice>/crombolo/api/forms/choices` (the Manage permission)
- An **entries view** per form with state filtering, search, a spam toggle,
  approve/reject/delete, and CSV export

A read-only schema directory **refuses the save** rather than appearing to take
it — the same rule the type editors follow, since the write would not survive a
redeploy.

### Exporting

CSV, one row per entry, a column per storing field in definition order. Two
details worth stating:

- A value starting `=`, `+`, `-` or `@` is prefixed with a quote. Without that a
  spreadsheet treats an exported answer as a **formula and runs it**.
- A form with a sensitive field **refuses the whole export** without
  sensitive-data access, rather than exporting blanks. A file that looks
  complete and quietly is not is worse than an error, because somebody will act
  on it.

## Permissions

**Built.** Five verbs, joining the existing group-permission machinery rather
than inventing a parallel one:

| Verb | Allows |
| --- | --- |
| `Crombolo.Form.Read` | reading a definition |
| `Crombolo.Form.Manage` | creating, editing and deleting one |
| `Crombolo.FormEntry.Read` | reading submissions |
| `Crombolo.FormEntry.Manage` | approving, rejecting, deleting them |
| `Crombolo.FormEntry.Sensitive` | seeing what a definition marks sensitive |

`Crombolo.`-prefixed, not `Umb.`: Umbraco has no forms in core, so these name
nothing upstream and the prefix says who defined them. Migration 026 rewrites
the `Umb.`-spelled rows that migration 025 wrote.

They are separate because the jobs are. **Designing a form is a developer's
job and reading what people sent it is not**, so an editor gets the entry verbs
and not `Manage`; an administrator gets all five. The `sensitiveData` group now
carries the sensitive verb, and its group alias still counts too, because that is
how Umbraco carries it and how members already work.

A *definition* is readable by any signed-in backoffice user, like a document
type — the form picker in the Content section needs it.

Granted by the seed, and to databases seeded earlier by **migration 025**, the
way migration 007 did.

## Conditions in the browser

**Built.** `/crombolo/forms.js`, served by the server and added to a layout by
the site — nothing emits it automatically, because a form works without it and
two forms on a page would otherwise run it twice.

It mirrors `isShown`/`evaluateRule` from core, and the two are **held against
each other** by `tests/forms-conditions.test.ts`: every operator, over a dozen
value shapes, through both implementations with the answers compared. If they
drifted, a visitor would watch a field appear and then be told it should not
have been there.

One subtlety worth recording: a conditionally-hidden field is **never rendered
`required`**. A browser with no JavaScript would otherwise refuse to submit over
a field nobody can see. The markup carries `data-required` instead, and the
script puts the attribute back when it reveals the field.

## What is built, and what is not

Built: definitions as files, the closed field-type set, whole-set validation,
entries with states and sensitive-data redaction, `<Form>` and the submission
endpoint, server-side validation and conditions, the honeypot and timing
guards, uploads, choices from a source, the three workflows on a retrying
queue, and field and workflow types from a bundle.

Not built yet:

| What | Story |
| --- | --- |
| A TSX email template (the setting is refused by name rather than ignored) | `091` |
| Entry retention and automatic deletion | `092` |

## Scope change

[`features.md`](features.md) lists Forms under "Out of scope for now". That
line goes, and the feature inventory gains a Forms section.
