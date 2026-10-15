# Umbraco 18.2.0 Content Delivery API security: behaviour notes

Source: `/Users/adam/dev/Umbraco-CMS` at tag `release-18.2.0`. Every path below is relative to the repo root.
The OpenIddict behaviour comes from openiddict-core **7.6.0** (the version pinned in `Directory.Packages.props`). Those source files
were downloaded to `scratchpad/oidc/` (`OpenIddictServerHandlers*.cs`, `OpenIddictServerAspNetCoreHandlers.cs`, `OpenIddictResources.resx`)
so the exact error strings could be quoted.

Confidence markers: **[code]** means read directly in source. **[oidc]** means read in OpenIddict 7.6.0 source. **[infer]** means inferred from ASP.NET Core or OpenIddict
defaults that were not read line by line, so verify it if it matters.

---

## 0. Configuration surface (`Umbraco:CMS:DeliveryApi`)

File: `src/Umbraco.Core/Configuration/Models/DeliveryApiSettings.cs` [code]

| Key | Default | Notes |
|---|---|---|
| `Enabled` | `false` | |
| `PublicAccess` | `true` | false means the `Api-Key` header is required for every content request |
| `ApiKey` | `null` | Used for non-public access **and** for preview |
| `Media.Enabled` | `false` | Has no effect unless `Enabled` is also true |
| `Media.PublicAccess` | `true` | Has no effect unless the top-level `PublicAccess` is also true |
| `MemberAuthorization.AuthorizationCodeFlow.Enabled` | `false` | |
| `MemberAuthorization.AuthorizationCodeFlow.LoginRedirectUrls` | `[]` (`IEnumerable<Uri>`) | Required (and must be absolute) when the flow is enabled |
| `MemberAuthorization.AuthorizationCodeFlow.LogoutRedirectUrls` | `[]` | Optional. If present, all must be absolute |
| `MemberAuthorization.ClientCredentialsFlow.Enabled` | `false` | |
| `MemberAuthorization.ClientCredentialsFlow.AssociatedMembers[]` | `[]` | `{ UserName, ClientId, ClientSecret }` |

`MemberAuthorizationIsEnabled()` = `AuthorizationCodeFlow.Enabled || ClientCredentialsFlow.Enabled`. This one switch decides
whether bearer tokens are looked at at all, and whether the `protected`/`protectedAccess` index fields are written and queried.

Token lifetimes come from `Umbraco:CMS:Global:TimeOut` (default `00:20:00`, `src/Umbraco.Core/Configuration/Models/GlobalSettings.cs`). See §3.7.

---

## 1. API key and PublicAccess

### 1.1 Where the checks are applied [code]
- `src/Umbraco.Cms.Api.Delivery/Controllers/Content/ContentApiControllerBase.cs` carries `[DeliveryApiAccess]`, so it applies to all content endpoints
  (`GET content/item/{id}`, `GET content/item/{*path}`, `GET content/items?id=..`, `GET content`).
- `src/Umbraco.Cms.Api.Delivery/Controllers/Media/MediaApiControllerBase.cs` carries `[DeliveryApiMediaAccess]`, so it applies to all media endpoints.
- `src/Umbraco.Cms.Api.Delivery/Controllers/Security/MemberController.cs` and `CurrentMemberController.cs` have **no** access attribute.
  The member auth endpoints therefore ignore `Enabled`, `PublicAccess` and `Api-Key` completely.
- Both filters are MVC action filters. On failure they set `context.Result = new UnauthorizedResult()`.

### 1.2 Decision logic: `src/Umbraco.Cms.Api.Delivery/Services/ApiAccessService.cs` [code]
```csharp
HasPublicAccess()  => Enabled && (PublicAccess || HasValidApiKey())
HasPreviewAccess() => Enabled && HasValidApiKey()
HasMediaAccess()   => Enabled && Media.Enabled && ((PublicAccess && Media.PublicAccess) || HasValidApiKey())
HasValidApiKey()   => !IsNullOrWhiteSpace(ApiKey) && ApiKey.Equals(Request.Headers["Api-Key"])
```
- Content filter (`Filters/DeliveryApiAccessAttribute.cs`): when the request is a preview (`IRequestPreviewService.IsPreview()`), it
  uses `HasPreviewAccess()`. Otherwise it uses `HasPublicAccess()`.
- Preview detection (`Services/RequestPreviewService.cs`): header `Preview` equals `"true"`, compared **case-insensitively**.
- Header names (`src/Umbraco.Core/Constants-DeliveryApi.cs`): `Api-Key`, `Preview`, `Start-Item`, `Accept-Language`, `Accept-Segment`.
  ASP.NET header lookup is case-insensitive on the header **name**.
- The key **value** is compared with `string.Equals`: ordinal, case-sensitive, not constant-time. A header sent more than once becomes
  a comma-joined `StringValues`, so it fails the comparison. A configured key that is empty or whitespace never matches, so preview is impossible without a key.
- `Services/RequestHeaderHandler.cs` is just `HttpContext?.Request.Headers[name]`. With no HttpContext it returns null.
- Settings are monitored (`IOptionsMonitor.OnChange`), so changes are hot-reloaded.

### 1.3 What the API key grants
- On content: access when `PublicAccess=false`, and **preview** (draft content via `Preview: true`). It does **not** bypass member
  protection, which is a separate check (§2) that also runs for preview and API-key requests.
- On media: access when either `PublicAccess` or `Media.PublicAccess` is false. There is no media preview.
- The output cache is skipped for preview requests and for any request where `HasPublicAccess()` is false
  (`Caching/DefaultDeliveryApiOutputCacheRequestFilter.cs`).

### 1.4 Status codes
- Access denied by the filter: **401, empty body**. `src/Umbraco.Cms.Api.Common/Configuration/ConfigureApiBehaviorOptions.cs` sets
  `SuppressMapClientErrors = true`, so 401/403/404 results are bare, with no ProblemDetails body.
- The **Delivery API being disabled** (`Enabled=false`) does **not** give 404. Controllers stay routed, the filters return **401** for content
  and media, and the member security endpoints keep working (see §3.10).
- `Media.Enabled=false` also gives 401 on media endpoints.
- An unknown `Start-Item` gives 404 with the JSON string body `"The Start-Item could not be found"` (`Filters/ValidateStartItemAttribute.cs`).
- Query option errors give 400 ProblemDetails (title "Filter option not found" / "Selector option not found" / "Sort option not found").

### 1.5 Does PublicAccess (member protection) apply to media?
No. Media controllers have no member-access handling, and `RequestMemberAccessService` only takes `IPublishedContent` content paths.
Public access entries in Umbraco are content-only.

### 1.6 OpenAPI
`OpenApi/Transformers/ApiKeyTransformer.cs` adds the `ApiKeyAuth` scheme (apiKey, header `Api-Key`) to every operation.
`MemberAuthenticationSecurityRequirementsTransformer.cs` adds the `UmbracoMember` OAuth2 authorization code scheme, using the authorization and token URLs from `Paths.MemberApi`.

---

## 2. Protected content (member access)

### 2.1 Building blocks
- `src/Umbraco.Cms.Api.Delivery/Services/RequestMemberAccessService.cs` [code]
  - `GetRequestPrincipal()` returns **null immediately if `MemberAuthorizationIsEnabled()` is false**. Otherwise it calls
    `HttpContext.AuthenticateAsync(OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme)` (the OpenIddict validation scheme).
    If that fails (no token, bad token, expired token), the result is a null principal, which means anonymous. **An invalid token never gives a 401 on its own.**
  - `MemberHasAccessToAsync(content)`:
    1. `publicAccessService.GetEntryForContent(content.Path)` looks for the nearest entry on the node itself or an ancestor
       (deepest id first; `src/Umbraco.Core/Services/PublicAccessService.cs:77`). No entry means `AccessAccepted`.
    2. A null principal means `NotLoggedIn`.
    3. Otherwise `IPublicAccessChecker.HasMemberAccessToContentAsync(content.Id, principal)`.
  - `MemberAccessAsync()` returns `new ProtectedAccess(memberKey, memberRoles)`, built from the token claims `umbraco-member-key` (Guid) and
    `umbraco-member-roles` (split on `,`). Both are null when anonymous.
- `src/Umbraco.Core/Models/DeliveryApi/ProtectedAccess.cs`: `{ Guid? MemberKey; string[]? MemberRoles }`, with `None = (null, null)`.
- `src/Umbraco.Web.Common/Security/PublicAccessChecker.cs` [code], evaluated in this order:
  1. principal not authenticated → `NotLoggedIn`
  2. `memberManager.GetUserAsync(principal)` returns null (member deleted, for example) → `NotLoggedIn`
  3. member not approved → `NotApproved`
  4. member locked out → `LockedOut`
  5. `publicAccessService.HasAccess(contentId, contentService, username, roles)` false → `AccessDenied`
  6. → `AccessAccepted`

  Roles here come from **`memberManager.GetRolesAsync`**, so they are live from the database and not taken from the token.
- Rule evaluation (`src/Umbraco.Core/Services/PublicAccessServiceExtensions.cs`): access is granted if **any** rule on the entry matches.
  A rule matches when it is `RuleType == "MemberUsername"` and `RuleValue` equals the username **case-insensitively** (OrdinalIgnoreCase),
  **or** when it is `RuleType == "MemberRole"` and `roles.Contains(RuleValue)` (**case-sensitive**). Constants are in `src/Umbraco.Core/Constants-Conventions.cs:83-88`.

### 2.2 Item endpoints: `Controllers/Content/ContentApiItemControllerBase.cs` [code]
```
AccessAccepted → continue
AccessDenied   → 403 (StatusCodeResult(403), empty body; deliberately not Forbid(), to avoid a cookie redirect)
NotLoggedIn | NotApproved | LockedOut → 401 (UnauthorizedResult, empty body)
```
- `ByIdContentApiController`: missing item → 404, then the member check, then a builder null result → 404.
- `ByRouteContentApiController`: the path resolves, then the member check. The preview path `/preview-{guid}` only works when the `Preview: true`
  header is present. If nothing resolves, the redirect lookup gives a **301** with `Location-Start-Item-Path` / `Location-Start-Item-Id` headers, or 404 otherwise.
- `ByIdsContentApiController`: checks each item in the order the cache returns them, and **the first failure wins for the whole request**
  (one protected item gives 401/403 for the entire batch). Missing ids are silently dropped.
- Consequence: if member auth is **disabled** but content has public access entries, protected items always return **401** on item
  endpoints, because the principal is always null.

### 2.3 Query endpoint (`GET content`): `QueryContentApiController` + `Services/QueryBuilders/ApiContentQuerySelectorBuilder.cs` [code]
- It calls `MemberAccessAsync()` and passes `ProtectedAccess` into the Examine query.
- The filter is added **only if `MemberAuthorizationIsEnabled()`**. **With member auth disabled, protected content is NOT filtered out of query
  results** (and the index carries no `protected` field). Item endpoints would still 401 for that same content.
- Index fields (`src/Umbraco.Infrastructure/Examine/DeliveryApiContentIndexValueSetBuilder.cs:89-94, 150-176`), written only when member auth is enabled:
  - `protected` = `"y"` if a public access entry applies to the node (own or ancestor), otherwise `"n"`.
  - `protectedAccess` = one value per rule on that entry: `r:{roleName}` for a MemberRole rule, or `u:{memberKey}` for a MemberUsername
    rule (the username is resolved to the member key at index time; an unknown username is dropped). Field names are in `UmbracoExamineFieldNames.DeliveryApiContentIndex`.
- Lucene logic:
  - Anonymous (no key and no roles): `AND protected:n`.
  - Member: `AND (protected:n OR protectedAccess:(u:{key} OR r:{role1} OR r:{role2}...))`.
  - Roles come from the **token claim** (`umbraco-member-roles`), which is a snapshot taken at sign-in. Tokens are revoked when roles change (§3.9).
  - The query path does **not** check approved or locked-out status. It relies on the token revocation handler for that.
- `Total` in the paged result is the filtered count. There is no 401 or 403 from the query endpoint.

### 2.4 Expanded references in responses
`src/Umbraco.Cms.Api.Common/Rendering/ElementOnlyOutputExpansionStrategy.cs:170-195` [code]: when a content picker or MNTP reference is
**expanded** and `MemberHasAccessToAsync` is not `AccessAccepted`, the reference is still output (id, route and so on) but its `properties` are
**cleared**, so a client can link to a page that will 401. A reference that is not expanded is returned as normal. A disallowed content type
gives null (single) or is omitted (collection). Tests: `tests/Umbraco.Tests.Integration/Umbraco.Api.Delivery/Rendering/OutputExpansionStrategyAccessControlTests.cs`.

### 2.5 What an anonymous caller gets (member auth enabled)
- Item request for protected content: **401**, empty body.
- Query: protected items are silently excluded.
- Expanded references to protected content: shell only, with properties `{}`.

### 2.6 Output cache caveat [code + infer]
The content cache policy varies only by `Accept-Language`, `Accept-Segment`, `Start-Item` (plus custom providers). It does **not** vary by
`Authorization`, and `IsCacheable` only excludes preview and non-public-access requests
(`Caching/DeliveryApiOutputCachePolicyBase.cs`, `DefaultDeliveryApiOutputCacheRequestFilter.cs`). Output caching is off by default.
If we copy it, exclude requests that carry a bearer token or protected items from the cache (Umbraco appears not to).

---

## 3. Member authorization endpoints

### 3.1 Paths: `src/Umbraco.Cms.Api.Common/Security/Paths.cs` [code]
Hard-coded to **v1**, never v2, even though content and media are `[ApiVersion("2.0")]`:
```
/umbraco/delivery/api/v1/security/member/authorize   (GET; OpenIddict authorization endpoint, passthrough)
/umbraco/delivery/api/v1/security/member/token       (POST; token endpoint, passthrough)
/umbraco/delivery/api/v1/security/member/signout     (GET; OpenIddict end-session endpoint, passthrough)
/umbraco/delivery/api/v1/security/member/revoke      (POST; revocation, handled entirely by OpenIddict, no controller)
/umbraco/delivery/api/v1/security/member/userinfo    (GET; userinfo endpoint, passthrough to CurrentMemberController)
```
- The controllers use `[ApiVersion("1.0")]` + `[VersionedDeliveryApiRoute("security/member")]`, which gives `delivery/api/v{version}/security/member/...`
  under the backoffice route prefix `/umbraco/`. They are hidden from OpenAPI (`IgnoreApi = true`).
- Registered with OpenIddict in `src/Umbraco.Cms.Api.Common/DependencyInjection/UmbracoBuilderAuthExtensions.cs`. The member endpoints are listed **before** the
  back-office ones, so `/.well-known/openid-configuration` advertises the **member** endpoints as the primary ones.
- OpenIddict only processes requests whose path starts with `/umbraco/` or `/.well-known/openid-configuration`/`/.well-known/jwks`
  (`DependencyInjection/ProcessRequestContextHandler.cs`).
- HTTPS: when `Global.UseHttps=false`, `DisableTransportSecurityRequirement=true` (`Configuration/ConfigureOpenIddict.cs`). Otherwise an HTTP
  request to these endpoints gives `invalid_request` "This server only accepts HTTPS requests." (ID2083) [oidc].

### 3.2 OpenIddict server configuration [code]
- Flows: `AllowAuthorizationCodeFlow().RequireProofKeyForCodeExchange().AllowRefreshTokenFlow()` and `AllowClientCredentialsFlow()`.
- Tokens: **reference** access and refresh tokens, Data Protection format (opaque to clients, not JWT). Validation uses `UseLocalServer()`, `EnableTokenEntryValidation()`
  (the DB token entry must exist and be valid, so deleting the token row revokes it immediately).
- Scopes known to the server: `openid` (default) and `offline_access` (added by `AllowRefreshTokenFlow`) [oidc OpenIddictServerOptions/Builder].
  No other scopes are registered, so any other scope gives `invalid_scope` "The specified 'scope' is invalid." (ID2052) at authorize.
- PKCE: required for `response_type=code`. Allowed `code_challenge_method` values are `plain` **and** `S256` (OpenIddict default set). Because
  `plain` is enabled, `code_challenge_method` may be omitted and defaults to plain [oidc].

### 3.3 Client registrations: `src/Umbraco.Cms.Api.Delivery/Security/MemberApplicationManager.cs` [code]
**Interactive client** (`EnsureMemberApplicationAsync`):
```
ClientId     = "umbraco-member"           (Constants.OAuthClientIds.Member, src/Umbraco.Core/Constants-OAuthClientIds.cs)
DisplayName  = "Umbraco member access"
ClientType   = public                     (no secret)
Permissions  = ept:authorization, ept:token, ept:end_session, ept:revocation,
               gt:authorization_code, gt:refresh_token, rst:code
RedirectUris           = LoginRedirectUrls
PostLogoutRedirectUris = LogoutRedirectUrls
```
**Client-credentials clients** (`EnsureMemberClientCredentialsApplicationAsync`), one per AssociatedMember:
```
ClientId     = "umbraco-member-" + configured ClientId (prefix ensured, see §3.8)
ClientSecret = configured ClientSecret (OpenIddict stores a hash)
DisplayName  = "Umbraco client credentials member access: {clientId}"
ClientType   = confidential
Permissions  = ept:token, ept:revocation, gt:client_credentials
```
`OpenIdDictApplicationManagerBase.CreateOrUpdate` (`src/Umbraco.Infrastructure/Security/OpenIdDictApplicationManagerBase.cs`) creates the application, or
updates it only when it has changed (always when a secret is present), retrying up to 5 times on concurrency exceptions.

### 3.4 Startup registration: `src/Umbraco.Cms.Api.Delivery/Handlers/InitializeMemberApplicationNotificationHandler.cs` [code]
Runs on `UmbracoApplicationStartingNotification`, only at `RuntimeLevel.Run`, and **not on Subscriber servers**. A static lock means it runs once per process.
- `AuthorizationCodeFlow.Enabled != true` → **delete** the `umbraco-member` application.
- `LoginRedirectUrls` empty → warning "No redirect URLs defined for Delivery API member authentication - cannot enable member authentication", then delete.
- Any login URL not absolute → warning "All redirect URLs defined for Delivery API member authentication must be absolute - cannot enable member authentication", then delete.
- `LogoutRedirectUrls` non-empty but any not absolute → same warning, then delete.
- Otherwise ensure the application exists.
- `ClientCredentialsFlow.Enabled == true` → ensure one confidential application per `AssociatedMembers` entry. **Applications are never deleted**
  when the flow is disabled or an entry is removed. Stale applications stay in the DB (see §3.8 for what happens if they are used).
- No startup failure for bad config, only log warnings and a disabled flow. `MemberApplicationManager` would throw `ArgumentException`
  ("Expected absolute login redirect URLs for Delivery API member authentication") for relative URLs, but the handler validates first, so that is unreachable through it.

### 3.5 Authorize flow: `MemberController.Authorize` [code + oidc]
OpenIddict validates the request **before** the controller runs (passthrough). Validation order [oidc `OpenIddictServerHandlers.Authentication.cs`]:
client_id present → client exists → redirect_uri present and absolute with no fragment → response_type supported → scope syntax → PKCE params →
redirect_uri registered for the client → scopes known → endpoint/grant/response-type permissions → PKCE required.

Then the controller does the following:
1. `AuthorizationCodeFlow.Enabled != true` → `400 {"error":"Not allowed","error_description":"Member authorization is not allowed."}`.
   In practice this is rarely reached: the application has been deleted, so OpenIddict has already rejected `client_id`.
2. No OpenIddict request → `400 {"error":"No context found","error_description":"Unable to obtain context from the current request."}`.
3. `client_id != "umbraco-member"` → `400 {"error":"Invalid 'client ID'","error_description":"The specified 'client_id' is not valid."}`.
   This blocks back-office client ids (`umbraco-back-office`, etc.) on the member endpoint.
4. If `identity_provider` is **absent or blank**, the internal login path runs:
   - `AuthenticateAsync(IdentityConstants.ApplicationScheme)` reads the **member cookie** (`Identity.Application`, set by the site's normal member
     login, for example a Razor login form through `MemberSignInManager`).
   - If not signed in → `Challenge(IdentityConstants.ApplicationScheme)`. The member cookie options
     (`src/Umbraco.Web.Common/Security/ConfigureMemberCookieOptions.cs`) set `LoginPath = null`, and ASP.NET Core's cookie PostConfigure then falls back to
     the default `/Account/Login` [infer]. Result: **302 to `{LoginPath}?ReturnUrl={url-encoded original authorize URL with its query}`**.
     For XHR requests (`X-Requested-With: XMLHttpRequest` header or query), it returns **401** with `Location` set instead. The site is expected to set the member
     cookie's LoginPath to its own login page. After login the browser returns to the authorize URL and the flow continues.
   - Signed in, but `FindByNameAsync` fails → `400 {"error":"Authorization failed","error_description":"The member associated with the supplied 'client_id' could not be found."}`.
   - Signed in → `SignInMember` (§3.7). OpenIddict then **302s to `redirect_uri?code=...&state=...&iss=...`** (query response mode for code; the `iss` parameter is added by OpenIddict's `AttachIssuer`) [oidc].
5. If `identity_provider=<scheme>` is present, the external login path runs (member external providers are registered with the scheme prefix `UmbracoMembers.`,
   `src/Umbraco.Core/Constants-Security.cs:169`; the parameter value must be the full scheme name, e.g. `UmbracoMembers.Google`):
   - No external login info yet → `Challenge(properties, provider)` where `RedirectUri` = null, so ASP.NET's remote handler uses the current
     authorize URL [infer]. The provider round trip ends back at the authorize endpoint.
   - `ExternalLoginSignInAsync(loginInfo, isPersistent:false, bypassTwoFactor:true)` succeeds → `FindByLoginAsync` → update external tokens → `SignInMember`.
     Member null → 400 "Authorization failed" / "The member associated with the supplied 'client_id' could not be found."
   - Sign-in fails (no linked member, not approved, locked out and so on) → `Forbid(props{error=access_denied, error_description="The member is not allowed to access this resource."}, provider)`.
     **Quirk:** Forbid is sent to the *external* scheme, not to OpenIddict, so the client probably does **not** get an OAuth error redirect. It gets whatever that
     provider's forbid does, usually a cookie access-denied redirect or 403 [infer].
   - No 2FA support for members in this flow.
6. When the member is not signed in there are no prompt or consent screens. `prompt=none` is not specially handled by Umbraco.

**Redirect URL validation:** OpenIddict compares `redirect_uri` against the application's `RedirectUris` (= `LoginRedirectUrls`) with an exact string match [oidc/infer: ordinal].
Failure gives `invalid_request` "The specified 'redirect_uri' is not valid for this client application." (ID2043). Like every validation-stage error at
authorize, it is **not redirected**. OpenIddict renders a local **400 `text/plain;charset=UTF-8`** body made of `key:value` lines [oidc `ProcessLocalErrorResponse`]:
```
error:invalid_request
error_description:The specified 'redirect_uri' is not valid for this client application.
error_uri:https://documentation.openiddict.com/errors/ID2043
```
(`state` is stripped from local error responses.)

### 3.6 Token endpoint: `MemberController.Token` (POST, form-encoded) [code + oidc]
OpenIddict validates first (grant_type, client and its type, secret, permissions, code/refresh token validity, PKCE verifier, redirect_uri match). Then:
- `grant_type=authorization_code` or `refresh_token`, **and** `AuthorizationCodeFlow.Enabled`: the controller calls
  `AuthenticateAsync(OpenIddictServer scheme)` to get the principal stored in the code or refresh token and **re-signs it unchanged**. Claims and roles are therefore
  **not refreshed** on refresh; freshness comes from revocation (§3.9). On failure: `400 {"error":"Authorization failed","error_description":"The supplied authorization could not be verified."}`.
- `grant_type=client_credentials` **and** `ClientCredentialsFlow.Enabled`: client_id and secret are already verified by OpenIddict, then
  `MemberClientCredentialsManager.FindMemberAsync(client_id)` → `SignInMember`. If no member is found: `400 {"error":"Authorization failed","error_description":"Invalid 'client_id' or client configuration."}`.
- Anything else (for example client_credentials with the flow disabled but a stale application still registered, or code exchange with the code flow disabled but the application
  still present) → `throw new InvalidOperationException("The requested grant type is not supported.")`, which gives **HTTP 500**.
- Request examples:
```
POST /umbraco/delivery/api/v1/security/member/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=umbraco-member&code=...&redirect_uri=https://site/callback&code_verifier=...

grant_type=refresh_token&client_id=umbraco-member&refresh_token=...

grant_type=client_credentials&client_id=umbraco-member-myclient&client_secret=...
(or HTTP Basic client auth; client_secret_basic and client_secret_post are both accepted by OpenIddict defaults [infer])
```
- Success response (OpenIddict standard JSON) [infer shape]:
```json
{ "access_token": "<opaque reference>", "token_type": "Bearer", "expires_in": 300,
  "scope": "openid offline_access", "refresh_token": "<opaque>", "id_token": "<JWT, only if openid granted>" }
```
  `refresh_token` appears only when `offline_access` was granted (never for client_credentials). The exact `id_token` presence and contents were not verified.
  Umbraco only sets AccessToken destinations.

### 3.7 SignInMember: claims, scopes, lifetimes [code]
- Principal = `MemberSignInManager.CreateUserPrincipalAsync(member)` (standard Identity claims: name identifier = member int id, name = username,
  roles, security stamp, and so on), plus:
  - `sub` = member **Key** (Guid "D" format)
  - `umbraco-member-key` = member Key (`Constants.OAuthClaims.MemberKey`, `src/Umbraco.Core/Constants-OAuthClaims.cs`)
  - `umbraco-member-roles` = role names joined with `,` (no escaping; a role containing a comma would break)
  - every claim except the security stamp claim gets destination = **access_token only**
- Scopes: `request.GetScopes() ∩ {openid, offline_access}`. Anything else is silently dropped (after OpenIddict has already rejected unknown scopes at authorize).
  `offline_access` is required to get a refresh token.
- Lifetimes (`UmbracoBuilderAuthExtensions.cs`), read once at startup from `Global:TimeOut` (default 20 min):
  - access token = `TimeOut / 4` (default **5 min**)
  - refresh token = `TimeOut` (default **20 min**)
  - authorization code = OpenIddict default **5 min**; identity token = OpenIddict default 20 min [oidc OpenIddictServerOptions].
  - OpenIddict defaults (not overridden): rolling refresh tokens (a new refresh token on each use, the old one redeemed, with a 30 s reuse leeway) and sliding expiration [oidc].
- Lifetimes and token handling are shared with back-office tokens. `HideBackOfficeTokensHandler` only touches `client_id == umbraco-back-office`, so member
  tokens are returned in the response body normally.

### 3.8 Client credentials: `src/Umbraco.Infrastructure/Security/MemberClientCredentialsManager.cs` [code]
- `ClientIdPrefix = "umbraco-member"`. `SafeClientId(id) = id.EnsureStartsWith("umbraco-member-")` (`ClientCredentialsManagerBase.cs`).
  Configured `ClientId: "myclient"` registers `umbraco-member-myclient`. Configured `umbraco-member-myclient` stays as it is.
- **The client must send the full prefixed id**, because OpenIddict looks the application up by the exact `client_id`. Sending `myclient` gives `invalid_client` 401 [oidc].
- `FindMemberAsync(clientId)`: returns null if the flow is disabled or there are no AssociatedMembers. Otherwise it finds the first entry with
  `SafeClientId(entry.ClientId) == SafeClientId(clientId)` (ordinal), then `memberManager.FindByNameAsync(entry.UserName)` (logs a warning if the member is missing).
- The resolved member signs in through the same `SignInMember` (sub = member key and so on). Scopes: only `openid` is useful; `offline_access` gives
  `invalid_request` "The client application is not allowed to use the 'offline_access' scope." (ID2065), because there is no refresh_token permission [oidc].
- No validation of AssociatedMembers at startup (duplicates, empty secret, unknown username are all accepted silently).
- **Management API member kind**: `src/Umbraco.Cms.Api.Management/Factories/MemberPresentationFactory.cs:232-250`. The `Kind` is `MemberKind.Api` when the member's key is
  among the members whose usernames appear in `DeliveryApi.MemberAuthorization.ClientCredentialsFlow.AssociatedMembers[].UserName`
  (resolved with `memberService.GetByUsername`, cached per factory instance). **This does not check `ClientCredentialsFlow.Enabled`.** Otherwise the kind is `Default`.
  External-only members are `ExternalOnly`. Enum: `src/Umbraco.Core/Models/Membership/MemberKind.cs` (`Default=0, Api, ExternalOnly`). Serialised in the Management API as `"Default" | "Api" | "ExternalOnly"`.

### 3.9 Token revocation on member changes: `src/Umbraco.Cms.Api.Delivery/Handlers/RevokeMemberAuthenticationTokensNotificationHandler.cs` [code]
Runs only when `MemberAuthorizationIsEnabled()`. It deletes **all** OpenIddict tokens with `subject == member.Key` when:
- a member is saved and is locked out or not approved (also for external members)
- a member is deleted (also for external members)
- roles are assigned to or removed from a member (also for external members)

Because tokens are reference tokens with entry validation, this takes effect immediately. Changing a username or email does **not** revoke tokens.

### 3.10 Signout: `MemberController.Signout` (GET) [code + oidc]
- `memberSignInManager.SignOutAsync()` clears the member cookie. `SignOut(OpenIddictServer scheme)` then completes the end-session request.
- `post_logout_redirect_uri` is validated by OpenIddict against the registered `PostLogoutRedirectUris` (= `LogoutRedirectUrls`). If none are configured, any
  supplied value is rejected. Errors: `invalid_request` "The specified 'post_logout_redirect_uri' is invalid." (ID2052), "The 'post_logout_redirect_uri' parameter must be a valid absolute URI."
  (ID2030), "...must not include a fragment." (ID2031). These are rendered as local text/plain 400 [oidc].
- Valid → 302 to `post_logout_redirect_uri` (with `state` echoed) [infer]. With no post_logout_redirect_uri → empty 200 [infer].
- **It does not revoke access or refresh tokens.** Clients should call `/revoke` as well.

### 3.11 Revoke (POST, OpenIddict only)
`token=...&token_type_hint=refresh_token|access_token&client_id=umbraco-member` (or the CC client with its secret). Success gives 200 with an empty body.
Errors [oidc]: missing token gives `invalid_request` "The mandatory 'token' parameter is missing."; an unknown client gives `invalid_client` 401;
a token belonging to another client gives `invalid_token` "The client application is not allowed to revoke the specified token." (ID2080).

### 3.12 Userinfo: `Controllers/Security/CurrentMemberController.cs` + `Services/CurrentMemberClaimsProvider.cs` [code]
`[Authorize(AuthenticationSchemes = OpenIddictServer scheme)]`. `GET .../userinfo` with `Authorization: Bearer <access_token>` returns:
```json
{ "sub": "<member key guid>", "name": "<member name>", "email": "<email>", "role": ["Group A", "Group B"] }
```
`name` and `email` are omitted when null. `role` comes from live `GetRolesAsync`. A missing or invalid token gives 401 with `WWW-Authenticate: Bearer error=...` [oidc AttachHttpResponseCode/AttachWwwAuthenticateHeader].

### 3.13 How content endpoints accept the bearer token [code + oidc]
- Scheme: `OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme` ("OpenIddict.Validation.AspNetCore"), invoked explicitly by `RequestMemberAccessService`.
  It is not the default scheme and there is no `[Authorize]` on the content controllers.
- Token sources, all enabled by default: the `Authorization: Bearer <token>` header, the form body `access_token`, and the **query string `access_token`**
  (`OpenIddictValidationAspNetCoreOptions` has all `Disable*` flags false).
- Identity: the **`umbraco-member-key`** claim (Guid) is used for the query filter. `PublicAccessChecker` resolves the member through `memberManager.GetUserAsync(principal)`
  (the Identity user-id claim, which is the member's int id) for item checks. Roles for the query filter come from the `umbraco-member-roles` claim, and roles for item checks come from the DB.
- No Delivery-API-specific scope check: any valid member access token works (including client-credentials tokens).
- When `MemberAuthorizationIsEnabled()` is false, the token is ignored entirely.

---

## 4. Error response catalogue

Shape notes:
- Umbraco controller errors: `BadRequest(new OpenIddictResponse{...})` serialises as JSON `{"error": "...", "error_description": "..."}` with status 400
  (OpenIddictMessage has its own JSON converter, so the snake_case parameter names are kept [infer]).
- OpenIddict **token/revoke** errors: JSON `{"error","error_description","error_uri"}`. Status is 400, except `invalid_client` → **401** plus
  `WWW-Authenticate: Basic ...`, and `server_error` → 500 [oidc `AttachHttpResponseCode`].
- OpenIddict **authorize/end-session** validation errors: 400 `text/plain;charset=UTF-8`, `error:...\nerror_description:...\nerror_uri:...` (never redirected).
- `error_uri` = `https://documentation.openiddict.com/errors/IDxxxx`.

| Endpoint | Case | Status | error | error_description |
|---|---|---|---|---|
| authorize | code flow disabled but app present | 400 JSON | `Not allowed` | Member authorization is not allowed. |
| authorize | non-member client_id that OpenIddict accepted (e.g. a back-office client) | 400 JSON | `Invalid 'client ID'` | The specified 'client_id' is not valid. |
| authorize | missing client_id | 400 text | invalid_request | The mandatory 'client_id' parameter is missing. |
| authorize | unknown client_id (incl. app deleted because the flow is disabled or misconfigured) | 400 text | invalid_request | The specified 'client_id' is invalid. |
| authorize | missing redirect_uri | 400 text | invalid_request | The mandatory 'redirect_uri' parameter is missing. |
| authorize | relative redirect_uri | 400 text | invalid_request | The 'redirect_uri' parameter must be a valid absolute URI. |
| authorize | unregistered redirect_uri | 400 text | invalid_request | The specified 'redirect_uri' is not valid for this client application. |
| authorize | missing response_type | 400 text | invalid_request | The mandatory 'response_type' parameter is missing. |
| authorize | response_type=token etc. | 400 text | unsupported_response_type | The specified 'response_type' is not supported. |
| authorize | missing code_challenge | 400 text | invalid_request | The mandatory 'code_challenge' parameter is missing. |
| authorize | bad code_challenge_method | 400 text | invalid_request | The specified 'code_challenge_method' is not supported. |
| authorize | unknown scope (e.g. `profile`) | 400 text | invalid_scope | The specified 'scope' is invalid. |
| authorize | member not found after login | 400 JSON | `Authorization failed` | The member associated with the supplied 'client_id' could not be found. |
| authorize | not logged in | 302 to LoginPath?ReturnUrl=… (401 + Location for XHR) | | |
| token | missing grant_type | 400 | invalid_request | The mandatory 'grant_type' parameter is missing. |
| token | unsupported grant (e.g. password) | 400 | unsupported_grant_type | The specified 'grant_type' is not supported. |
| token | unknown client_id | 401 | invalid_client | The specified 'client_id' is invalid. |
| token | public client sends a secret | 401 | invalid_client | The 'client_secret' parameter is not valid for this client application. |
| token | public client uses client_credentials | 400 | unauthorized_client | The specified 'grant_type' is not valid for this client application. |
| token | confidential client, no secret | 401 | invalid_client | Client authentication is required for this application. |
| token | wrong secret | 401 | invalid_client | The specified client credentials are invalid. |
| token | grant not permitted for client | 400 | unauthorized_client | This client application is not allowed to use the specified grant type. |
| token | CC + offline_access | 400 | invalid_request | The client application is not allowed to use the 'offline_access' scope. |
| token | missing code | 400 | invalid_request | The mandatory 'code' parameter is missing. |
| token | missing code_verifier | 400 | invalid_request | The mandatory 'code_verifier' parameter is missing. |
| token | wrong code_verifier | 400 | invalid_grant | The specified 'code_verifier' is invalid. |
| token | redirect_uri mismatch | 400 | invalid_grant | The specified 'redirect_uri' parameter doesn't match the client redirection URI the authorization code was initially sent to. |
| token | bad code | 400 | invalid_grant | The specified authorization code is invalid. |
| token | expired code | 400 | invalid_grant | The specified authorization code is no longer valid. |
| token | reused code | 400 | invalid_grant | The specified authorization code has already been redeemed. |
| token | bad / expired / reused refresh token | 400 | invalid_grant | The specified refresh token is invalid. / …is no longer valid. / …has already been redeemed. |
| token | CC client valid but no AssociatedMember / member missing | 400 JSON | `Authorization failed` | Invalid 'client_id' or client configuration. |
| token | grant valid at OIDC level but flow disabled in config | **500** | (InvalidOperationException "The requested grant type is not supported.") | |
| signout | post_logout_redirect_uri not registered | 400 text | invalid_request | The specified 'post_logout_redirect_uri' is invalid. |
| userinfo | missing / invalid token | 401 + WWW-Authenticate Bearer | missing_token / invalid_token | |
| content/media | access denied (disabled, no key, bad key) | 401, empty | | |
| content item | protected, anonymous / not approved / locked out | 401, empty | | |
| content item | protected, member lacks group/user rule | 403, empty | | |

(OpenIddict descriptions are from `OpenIddictResources.resx` 7.6.0: ID2029 "The mandatory '{0}' parameter is missing.", ID2030 "The '{0}' parameter must be a valid absolute URI.",
ID2032 "The specified '{0}' is not supported.", ID2043 "The specified '{0}' is not valid for this client application.", ID2052 "The specified '{0}' is invalid.",
ID2053 "The '{0}' parameter is not valid for this client application.", ID2055 "The specified client credentials are invalid.", ID2064, ID2065, ID2072, ID2198, ID2001/2003/2010/2012/2016/2018.)

---

## 5. Startup / configuration validation
- `src/Umbraco.Core/Configuration/Models/Validation/DeliveryApiSettingsValidator.cs`: always returns Success. It only **warns** when content type aliases overlap between
  `AllowedContentTypeAliases` and `DisallowedContentTypeAliases` (the allow list wins). There is **no** validation of redirect URLs, API key or AssociatedMembers there.
- Redirect URL handling is the soft validation in `InitializeMemberApplicationNotificationHandler` (§3.4): warnings are logged and the `umbraco-member` application is deleted, so the
  flow is effectively off and authorize gives "The specified 'client_id' is invalid.". There is no startup exception.
- A config value that cannot be parsed as a `Uri` at all would fail options binding when the options are first resolved [infer].
- Token lifetimes read `Global:TimeOut` at DI build time, so changing it needs a restart.
- Tests worth reading: `tests/Umbraco.Tests.UnitTests/Umbraco.Cms.Api.Delivery/Security/MemberApplicationManagerTests.cs` (update-only-if-changed),
  `.../Services/RequestHeaderHandlerTests.cs`, `tests/Umbraco.Tests.UnitTests/Umbraco.Core/Configuration/Models/Validation/DeliveryApiSettingsValidatorTests.cs`,
  `tests/Umbraco.Tests.UnitTests/Umbraco.Cms.Api.Management/Factories/MemberPresentationFactoryTests.cs`, and the integration test in §2.4.
  There are no HTTP-level tests of the member OAuth endpoints in the repo.

---

## 6. Things to decide for our reimplementation (observed quirks)
1. Disabled API gives 401, not 404 (and the security endpoints stay live).
2. With member auth disabled, query results include protected content while item endpoints 401 it. That is arguably a bug; decide whether to copy it.
3. An invalid or expired bearer token is treated as anonymous on content endpoints (no 401 for the token itself).
4. Token roles are snapshotted for the query filter, while item checks use live roles. Revocation on role, approval or lock changes keeps the two consistent.
5. Signout does not revoke tokens.
6. Client-credentials applications are never deleted, and a disabled flow with a stale application gives 500 at the token endpoint.
7. `MemberKind.Api` ignores `ClientCredentialsFlow.Enabled`.
8. `plain` PKCE is allowed, and `code_challenge_method` is optional.
9. The output cache does not vary on Authorization.
10. Access tokens are accepted from the `access_token` query string.
