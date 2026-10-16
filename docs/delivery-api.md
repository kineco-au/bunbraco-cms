# The Delivery API

Umbraco's Content Delivery API v2 (`/umbraco/delivery/api/v2/**`), so a site can
be read headless — from a static-site build, an app or any framework — with the
same requests and the same JSON an Umbraco site answers. Story `050`.

`packages/api-delivery` holds it, over the published cache: every answer is read
from memory, so it is served by the nodes that render the site (`all` and `web`,
never `api`) and scales with them, not with the backoffice. The contract is
vendored as `packages/contracts/DeliveryApi.json` — Umbraco generates its spec at
runtime and commits none, so this is the integration suite's expected generic
contract at `release-18.2.0`: eight operations, content and media.
`bun run coverage:api` counts it in `docs/api-coverage.md` by sending each
operation to the handler.

The research behind every rule here, with Umbraco file references, is in
[`stories/05_completed/050-research/`](stories/05_completed/050-research/).

## Settings

Off unless a site turns it on, as Umbraco's `DeliveryApi:Enabled` is.

```ts
// crombolo.config.ts
export default defineConfig({
  deliveryApi: {
    enabled: true,
    publicAccess: true,          // false: every request needs the key
    apiKey: process.env.DELIVERY_KEY,
    disallowedContentTypeAliases: ['settings'],
    media: { enabled: true },
    memberAuthorization: {
      clientCredentialsFlow: {
        enabled: true,
        associatedMembers: [{ userName: 'shop', clientId: 'shop', clientSecret: process.env.SHOP_SECRET! }],
      },
      authorizationCodeFlow: {
        enabled: true,
        loginRedirectUrls: ['https://app.example.com/callback'],
        logoutRedirectUrls: ['https://app.example.com/'],
        loginPage: '/login',
      },
    },
  },
})
```

| Setting | Default | Environment |
| --- | --- | --- |
| `enabled` | `false` | `CROMBOLO_DELIVERY_API` |
| `publicAccess` | `true` | `CROMBOLO_DELIVERY_API_PUBLIC` |
| `apiKey` | none | `CROMBOLO_DELIVERY_API_KEY` |
| `allowedContentTypeAliases` / `disallowedContentTypeAliases` | none | — |
| `media.enabled`, `media.publicAccess` | `false`, `true` | `CROMBOLO_DELIVERY_API_MEDIA` |
| `memberAuthorization.*` | both flows off | — |
| `memberAuthorization.timeoutMinutes` | `20` | — (Umbraco's `Global:TimeOut`) |

## Access

As Umbraco's `ApiAccessService`: content needs `enabled` and either
`publicAccess` or the exact `Api-Key` header; media needs `media.enabled` too and
both public flags, or the key. A refused request, including one to a disabled
API, is a **401 with an empty body**; so are 403 and 404. A `Preview: true`
request needs the key — previewing drafts is a later story, so it is answered
from the published content.

## Output

Umbraco's shapes, camelCase, nulls written, dates ISO in UTC. A page:

```json
{
  "contentType": "page", "name": "Story",
  "createDate": "2026-10-15T09:12:44.123Z", "updateDate": "2026-10-15T10:00:00.000Z",
  "route": { "path": "/news/story", "queryString": null,
             "startItem": { "id": "…", "path": "home" } },
  "id": "…", "properties": { "title": "Story title" }, "cultures": {}
}
```

- `route.path` is relative to the page's root, whose own segment is
  `startItem.path`; the first root is `/`, another root `/<segment>` when the top
  level is hidden ([`rendering.md`](rendering.md), "URLs"). Paths follow this
  site's own URLs, so they have no trailing slash — Umbraco's
  `AddTrailingSlash = false`. A right-to-left culture keeps the page's segment first.
- `cultures` holds each culture's route; an invariant page has `{}`.
- Pickers are references — `properties` stays `{}` unless expanded. Media
  picker, multinode tree picker and multi URL picker are always arrays. Blocks
  and elements always carry their properties. Rich text is `{ markup, blocks }`
  with links resolved to this site's URLs; the `data-*` link attributes and the
  JSON output (`RichTextOutputAsJson`) are not built. A member picker is
  `"(unsupported)"`, as in Umbraco. An empty property is `null`.
- Media answers `path` (names, lowercased, root down, with a trailing slash, as
  Umbraco builds it), `url`, `extension`, `width`, `height`, `bytes`,
  `focalPoint`, `crops`, and its properties other than the `umbraco*` ones.

`expand` and `fields` take v2's grammar — `properties[$all]`,
`properties[picker[properties[$all]]]`, `fields=properties[title]`. `$all`
expands one level; `fields` never expands. Bad syntax is a 400 problem naming it
(Umbraco answers 500).

## Items and paths

- `item/{id}`, `item/{path}` and `items?id=…`: unknown or disallowed ids are
  omitted from `items`, duplicates once; one members-only item the caller cannot
  open answers 401 or 403 for the whole `items` request, as in Umbraco.
- A path resolves segment by segment, case-sensitively, ignoring trailing
  slashes; with the top level hidden, under any root, first match wins.
  `Start-Item` (a root's id or segment) resolves under that root; one that names
  no root is a 404 saying so.
- `Accept-Language` is used only when it is a single culture name; otherwise the
  default language. Domains are not consulted for the culture.

## Queries

`GET content`: `fetch` (`ancestors:`, `children:`, `descendants:` an id or a
path; `children:00000000-…` is the roots; absent is everything, or the
Start-Item's descendants), `filter` (`contentType:`, `name:` — values OR, `!`
negates, filters AND — and `createDate`/`updateDate` with `:`, `>`, `>:`, `<`,
`<:`; an unparsable date is dropped), `sort` (`createDate`, `updateDate`, `level`,
`name`, `sortOrder`; ascending only when the direction starts with `asc`), `skip`
(0), `take` (10). An unknown option is Umbraco's 400 problem —
`Selector option not found`, `Filter option not found`, `Sort option not found`.
An unresolvable target is an empty page. Without a sort the order is the tree's.

`GET media`: `fetch=children:` is required (`/` for the roots, an id, or a path of
names), filters `mediaType:` and `name:`, and the last sort wins — Umbraco's own
media rules.

## Search

`GET search?term=…` is a Crombolo addition; Umbraco's Delivery API has no search.
It answers published pages matching every word of `term`, best first, as content
items with two more fields: `score`, and `excerpt`, which is HTML with each
matching word in `<mark>` and everything else escaped. `contentType` (repeatable)
keeps to those types; `skip` (0) and `take` (10, at most 100) page through; the
culture is `Accept-Language`. `total` counts only what the caller may open: a
members-only page is left out unless the bearer token's member may see it. An
empty `term` answers no items. How the index works is in
[`search.md`](search.md#site-search-for-visitors).

## Members-only pages

The nearest protected ancestor governs, as on the site: a member is let in by
user name or by a group, both in any case, and must be approved and not locked
out. The check is the site's own (`memberMayOpen` in `@crombolo/core`). An item endpoint answers **401** to a caller who is not signed in and
**403** to a member not allowed. A members-only page is **never listed** in a
query for a caller who cannot open it — Umbraco lists them when member sign-in
is off. An expanded reference to one keeps its route but not its properties.
The rules are read once per request (`PublicAccessRepository.allRules`).

## Member sign-in

Under `/umbraco/delivery/api/v1/security/member/` (still v1 in Umbraco 18.2),
whether or not the content API is on. `packages/server/src/delivery-members.ts`.

- **Client credentials**, for a server reading members-only content on its own
  account: `POST token` with `grant_type=client_credentials`,
  `client_id=umbraco-member-<id>` and its secret (form or HTTP Basic). An access
  token only, no refresh. Those members show as kind `Api` in the backoffice,
  derived from the config.
- **Authorization code with PKCE**, for an app a member signs in to: `GET
  authorize` with `client_id=umbraco-member`, a registered `redirect_uri`,
  `response_type=code`, an **S256** `code_challenge`, and `scope` of `openid`
  and `offline_access`. A member not signed in is sent to `loginPage` with a
  `returnUrl`, signs in through the site's member login, and returns; the app
  gets `?code=…&state=…&iss=…` and exchanges it at `token` with the verifier.
  Refresh tokens roll: each is spent on use.
- `signout` clears the member's site session **and ends their tokens**; a
  `post_logout_redirect_uri` must be registered. `revoke` ends one token;
  `userinfo` describes the member.

Tokens are random and opaque; only their SHA-256 is stored
(`delivery_member_token`, migration 037). An access token lasts a quarter of
`timeoutMinutes`, a refresh token all of it, a code five minutes. A token is
accepted from the `Authorization` header only — never `?access_token=` — and an
invalid or expired one counts as anonymous. It is checked against the member as
they are now, so locking a member out, unapproving, deleting or regrouping them
takes effect at once.

Errors follow Umbraco and OpenIddict: authorize and sign-out refuse with plain
`error:` / `error_description:` lines and never redirect; the token endpoint
answers JSON, `invalid_client` with 401.

A misconfigured flow — no or relative redirect URLs, no login page — is said at
boot, and the flow is off, as Umbraco turns it off.

## Not built

Preview of drafts, `Accept-Segment`, output caching, rich text as JSON, domain
cultures in path resolution, the typed per-content-type contract, and external
login providers in the sign-in flow.
