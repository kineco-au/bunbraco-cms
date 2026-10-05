# Forms

Form building in core, not as an add-on. Umbraco Forms is a paid product; the
features below are the ones that matter, placed the way the rest of this CMS
places things.

The strategic point is not price. It is that **a form definition is structure**,
and structure lives in files here. Umbraco Forms stores definitions in the
database only — the file option was removed in v9 and the migration is explicitly
irreversible — so an Umbraco site cannot diff a form in a pull request, cannot
review a change to one, and cannot deploy a form with the code that renders it.
That is the same gap `schema/` closed for document types, and the same gap uSync
and Deploy exist to paper over.

## Placement

The rule from [`09-schema-as-code.md`](09-schema-as-code.md) decides it: what
changes a thing?

| Part | Changes with | Lives in |
| --- | --- | --- |
| Form definition — pages, groups, fields, validation, workflows | a deploy, or an editor on a site with a schema store | **Files** `schema/forms/*.toml` |
| Entries (submissions) and their state | a visitor submitting, an editor approving | **Database** |
| Entry values | the same | **Database** |
| Uploaded files | the same | the media store's blob space |

The obvious objection is that editors create forms in production, where
`schemaWritable` defaults off. [`12-schema-at-runtime.md`](12-schema-at-runtime.md)
already answered that: with `s3SchemaStore` or `azureSchemaStore` the store is the
truth, materialised locally at boot and published back on write. A form is created
in the backoffice and lands in the store exactly as a document type does.

Without a schema store configured, forms are developer-owned and read-only in
production — the same trade the rest of `schema/` makes, and the backoffice says so
rather than failing a save silently.

## The file format

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
  subject = "Contact form: {enquiryType}"
  template = "Views/Emails/enquiry.tsx"
```

`condition` sits on the field, group or page it governs. `workflow.on` is the
state transition that triggers it, which is what makes an approval flow possible
without a second concept.

## Field types

A closed set in the first release. Field types are an internal registry, not a
public extension point: the TOML vocabulary, the server validator, the TSX
renderer and the entry value shape all have to agree, and freezing that contract
before anything has stressed it would be a promise made too early. Opening it up
later is additive — the npm extension mechanism in
[`17-packages.md`](17-packages.md) is where it goes when it does.

| Type | Stores | Notes |
| --- | --- | --- |
| `shortAnswer` | one string | `pattern`, `placeholder`, `maxlength` |
| `longAnswer` | one string | `rows` |
| `email` | one string | validated, and the default reply-to source |
| `number` | one number | `min`, `max`, `step` |
| `date` | one ISO date | `min`, `max` |
| `checkbox` | one boolean | |
| `dropdown` | one string | `values`, or a prevalue source later |
| `singleChoice` | one string | radios over `values` |
| `multipleChoice` | string array | checkboxes over `values` |
| `fileUpload` | blob keys | `accept`, `max-size`; goes through the same value intake as media |
| `dataConsent` | one boolean | mandatory by default, and the text is the label |
| `titleAndDescription` | nothing | presentational |
| `richText` | nothing | presentational |
| `hidden` | one string | default value may be a substitution |

Password is deliberately absent: a form that collects a password is a form that
should not exist, and Umbraco only has it for legacy reasons.

## Validation

**The server is the only authority.** The client gets the same rules and uses them
for immediate feedback, but every submission is re-validated from the definition
before anything is stored, and so is every condition — a hidden field's value is
discarded rather than trusted, because "hidden" is a client-side claim.

This is a deliberate divergence. Umbraco Forms leans on ASP.NET unobtrusive
validation and its conditional logic is a client-side concern tied to CSS classes.
Here conditions are evaluated twice and the server's answer wins.

## Entries

Migration **023**, two tables, keyed by the form's UUID rather than a foreign key
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

## Workflows

Three in the first release, each a function over the entry:

- **`sendEmail`** — through the new email port, body from a TSX template
- **`saveAsContent`** — creates a document from mapped fields, optionally published
- **`sendToUrl`** — POSTs JSON to an endpoint, with configurable headers

Dropped from Umbraco's nine: **Post as XML**, **Save as an XML File** and **Send
XSLT Transformed Email** are 2010s integration shapes, and `sendToUrl` with JSON
covers what they were for. **Slack** is `sendToUrl` with a webhook URL, so it is a
documented recipe rather than a type. **Change Record State** becomes the
spam-handling and approval rules on the form, not a workflow a person wires up.

Workflows run through `jobs.ts`, which already claims each scheduled run
atomically across Postgres nodes, so a workflow runs once on a multi-node site and
a failed one can be retried without duplicating an email. A submission is stored
first and its workflows run after: a mail server being down must never lose an
entry.

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

**Built** — see [`14-configuration.md`](14-configuration.md#e-mail). Adapters over
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

A form renders as TSX, with the theme fallback chain Umbraco gets right:

```
Views/Forms/<theme>/<fieldType>.tsx   site's override for one field type
Views/Forms/<theme>/Form.tsx          site's override for the shell
<built-in default>                    everything not overridden
```

Resolution walks that list and stops at the first hit, so a site that wants a
different text input overrides one file. The views snapshot machinery in
`packages/render/src/snapshots.ts` already content-addresses and hot-reloads this
set, so form views cost nothing new.

A form reaches a page through a `formPicker` data type, rendered by a `<Form>`
component from `bunbraco`. Progressive enhancement is the baseline: the form is a
real `<form method="post">` that works without JavaScript, and the client script
adds conditional logic, inline validation and optional fetch submission on top.

Submissions POST to `/bunbraco/forms/<formKey>` with a signed, per-session token
in a hidden field. Rate limiting is per IP hash and per form.

## Spam

Honeypot and timing in core: a field real users never fill, and a minimum elapsed
time between render and submit. Both are free, invisible, and need no third party.
`marked-as-spam` entries are stored and flagged rather than dropped, because a
false positive that silently discards an enquiry is worse than one to review.

Turnstile is the pluggable escalation when that is not enough. reCAPTCHA is
deliberately not built in — three variants of it is Umbraco carrying history, and
sending every visitor to Google is a decision a site should take knowingly.

## Backoffice

None of this exists upstream to borrow. The vendored backoffice ships 44 packages
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
- The designer is ours: pages, groups, columns and fields with drag-and-drop, and
  a save that writes TOML through the schema writer
- An entries view per form with date filtering, search, state actions and CSV
  export

## Permissions

Four verbs, joining the existing group-permission machinery rather than inventing
a parallel one: `forms.view`, `forms.manage` (create and edit definitions),
`entries.view`, `entries.sensitive`. Granted to the built-in groups by the seed,
and to databases seeded earlier by the migration, the way migration 007 did.

## What is not in the first release

Named so the edges are a decision rather than an omission: prevalue sources
(manual `values` only for now), entry retention and GDPR auto-delete, the headless
definition and submission API, custom field and workflow types from npm, export
formats beyond CSV, data source types, and multi-column layouts beyond a simple
column count.

## Scope change

[`06-features.md`](06-features.md) lists Forms under "Out of scope for now". That
line goes, and the feature inventory gains a Forms section.
