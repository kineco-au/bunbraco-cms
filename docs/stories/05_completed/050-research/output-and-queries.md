# Umbraco Content Delivery API v2: behavioural notes (tag `release-18.2.0`)

All paths are relative to `/Users/adam/dev/Umbraco-CMS` at tag `release-18.2.0`, unless they say otherwise.
Shorthands: `D/` = `src/Umbraco.Cms.Api.Delivery/`, `CoreDA/` = `src/Umbraco.Core/DeliveryApi/`,
`Models/` = `src/Umbraco.Core/Models/DeliveryApi/`, `InfraVC/` = `src/Umbraco.Infrastructure/PropertyEditors/ValueConverters/`,
`CoreVC/` = `src/Umbraco.Core/PropertyEditors/ValueConverters/`.

Each statement is labelled by where it comes from. **[src]** means read directly from the code.
**[derived]** means inferred from how System.Text.Json (STJ) or ASP.NET Core behaves; confidence is noted on those.

---

## 0. Pipeline and serialization basics

### Routes [src]
- `D/Routing/VersionedDeliveryApiRouteAttribute.cs` registers the template `delivery/api/v{version:apiVersion}/{content|media}` under the Umbraco back-office path. The resulting prefixes are `/umbraco/delivery/api/v2/content` and `/umbraco/delivery/api/v2/media`.
- In 18.2 every content and media controller is `[ApiVersion("2.0")]`. Only the member auth controllers (`D/Controllers/Security/*`) are still `1.0`.
- Endpoints:
  - `GET content`: query.
  - `GET content/item/{id:guid}`
  - `GET content/item/{*path}`: catch-all. If `{id}` is not a GUID, the request falls through to this route.
  - `GET content/items?id=..&id=..`
  - The same four exist for `media`.
- `DeliveryApiItemsEndpointsMatcherPolicy` is a v1 leftover. It disambiguates `items` from `item/{*path}` using the presence of the `id` query key.

### Controller-level filters [src]
Content controllers (`D/Controllers/Content/ContentApiControllerBase.cs`) carry these filters, in order:
1. `[DeliveryApiAccess]`: returns 401 with an empty body when access fails.
2. `[ContextualizeFromAcceptHeaders]`
3. `[ValidateStartItem]`
4. `[AddVaryHeader]`
5. `[OutputCache(ContentCachePolicy)]`

Media controllers have `[DeliveryApiMediaAccess]` and `[OutputCache(MediaCachePolicy)]` only. They have no culture, segment or start-item handling.

The base class `D/Controllers/DeliveryApiControllerBase.cs` adds:
- `[ApiController]`
- the JSON options named `DeliveryApi`
- `Authorize(UmbracoFeatureEnabled)`
- `MaintenanceModeActionFilter`

### Response headers [src]
- `AddVaryHeader` always appends `Vary: Accept-Language, Accept-Segment, Preview, Start-Item` to content responses, after any existing `Vary` value.

### Error bodies [src]
- `src/Umbraco.Cms.Api.Common/Configuration/ConfigureApiBehaviorOptions.cs` sets `SuppressMapClientErrors = true`. As a result `NotFound()`, `Unauthorized()` and the 403 `StatusCodeResult` all have **empty bodies**; they are not ProblemDetails.
- Model-binding failures still produce the automatic `[ApiController]` 400 `ValidationProblemDetails`. Examples: `items?id=notaguid`, `skip=abc`. [derived]

### JSON serializer options [src]
Set in `D/DependencyInjection/UmbracoBuilderExtensions.cs` (`AddJsonOptions(Constants.JsonOptionsNames.DeliveryApi, ...)`):
- `PropertyNamingPolicy = JsonNamingPolicy.CamelCase`.
- `TypeInfoResolver = new DeliveryApiJsonTypeResolver()`. This is a `DefaultJsonTypeInfoResolver` subclass whose `GetDerivedTypes` returns `[]` (`D/Json/DeliveryApiJsonTypeResolver.cs`, `src/Umbraco.Infrastructure/Serialization/ContentJsonTypeResolverBase.cs`). So the Delivery API adds **no `$type` polymorphism of its own**.
- `JsonStringEnumConverter` with no naming policy. Enums serialize as PascalCase strings, for example `"linkType": "Content"`.
- No `DefaultIgnoreCondition`, so **nulls are written** (`"settings": null`, `"queryString": null` and so on).

The only built-in polymorphic type is `IRichTextElement`. It has `[JsonDerivedType(..., "RichTextRootElement"|"RichTextGenericElement"|"RichTextTextElement")]` in `Models/IRichTextElement.cs`. When values are serialized through the interface (the nested `elements` arrays), STJ emits `"$type": "RichTextGenericElement"` and so on. The root, which is held in the `object`-typed properties dictionary, is serialized by its runtime type and gets no `$type`. [derived, high confidence]

### Dates [src + derived]
- Values are `DateTime`, written in STJ's ISO-8601 round-trip format. Fractional seconds appear only when they are non-zero.
- Since v17, system dates are UTC. `PublishedContentFactory` calls `.EnsureUtc()` (`src/Umbraco.Core/Extensions/EntityFactoryDateTimeExtensions.cs`), so `createDate` and `updateDate` come out as `"2024-01-15T10:30:00.123Z"`, with a `Z`.
- `updateDate` for content is `content.CultureDate(variationContext)`:
  - invariant type → `UpdateDate`
  - variant type → the culture's `PublishedCultureInfo.Date`
  - variant type with no matching culture → `DateTime.MinValue`, which serializes as `"0001-01-01T00:00:00"`

  Source: `src/Umbraco.Core/Extensions/PublishedElementExtensions.cs:317`.
- Media `createDate` and `updateDate` are the plain `media.CreateDate` and `media.UpdateDate`.

### Property key order [derived, medium confidence; matters only for byte-exact output]
STJ puts `JsonPropertyOrder` first: `contentType` has `-100` and `cultures` has `100`. After that it lists the declared type's properties, most-derived type first.

There are two contracts:
- **Class contract**, used when a single item is returned: `Ok(apiContentResponse)` is serialized by its runtime type `ApiContentResponse`. Key order is `contentType, createDate, updateDate, route, id, name, properties, cultures`.
- **Interface contract**, used for `items` arrays, query `items` (`IEnumerable<IApiContentResponse>`) and MNTP arrays. Key order is `contentType, name, createDate, updateDate, route, id, properties, cultures`. This is the order shown in the vendored contract.

---

## 1. Response shapes

### 1.1 Content (`IApiContentResponse`): `Models/ApiContentResponse.cs`, `ApiContent.cs`, `ApiElement.cs`, `ApiContentRoute.cs`, `ApiContentStartItem.cs`

```json
{
  "contentType": "articlePage",
  "name": "My article",
  "createDate": "2024-05-01T09:12:44.123Z",
  "updateDate": "2024-05-02T10:00:00Z",
  "route": {
    "path": "/articles/my-article/",
    "queryString": null,
    "startItem": { "id": "6f3c...-...", "path": "home" }
  },
  "id": "a1c5d649-977f-4ea5-9b1c-b26055f3eed3",
  "properties": { "title": "Hello", "bodyText": { "markup": "<p>..</p>", "blocks": [] } },
  "cultures": {}
}
```

**`id`**
- `content.Key`, a GUID in "D" format, lowercase.

**`contentType`**
- The content type alias, unchanged.

**`name`**
- `IApiContentNameProvider.GetName` returns `content.Name` for the current variation context culture (`CoreDA/ApiContentNameProvider.cs`).

**`route`**
- Built by `IApiContentRouteBuilder`; see section 2.
- `queryString` is always serialized, normally as `null`. It is only set for links inside rich text.

**`properties`**
- A dictionary of property alias → Delivery API value. It is always an object and never null. See section 3.

**`cultures`**
- `ApiContentResponseBuilder.GetCultures` (`CoreDA/ApiContentResponseBuilder.cs`) iterates `content.Cultures`.
- It skips the invariant entry (empty culture).
- It skips any culture whose route can't be built, i.e. the culture is unpublished or unroutable.
- The map is keyed by the culture code as stored in Umbraco, for example `"en-US"`.
- Each value is a full route object.
- Invariant content always gets `{}`. The acceptance helper confirms this (`tests/Umbraco.Tests.AcceptanceTest/lib/helpers/differentAppSettingsHelpers/ContentDeliveryApiHelper.ts`, `verifyCulturePropertyForContentItem`).

```json
"cultures": {
  "en-US": { "path": "/child-en-us/", "queryString": null, "startItem": { "id": "...", "path": "root-1-en-us" } },
  "da-DK": { "path": "/child-da-dk/", "queryString": null, "startItem": { "id": "...", "path": "root-1-da-dk" } }
}
```

**Nested content** (content picker, MNTP) is `IApiContent`, built by `ApiContentBuilder`. It has the same shape **without `cultures`**.

### 1.2 Media (`IApiMediaWithCropsResponse`): `Models/ApiMedia.cs`, `IApiMediaWithCrops*.cs`, `src/Umbraco.Infrastructure/Models/DeliveryApi/ApiMediaWithCrops*.cs`, builder `src/Umbraco.Infrastructure/DeliveryApi/ApiMediaWithCropsResponseBuilder.cs`

```json
{
  "path": "/folder/my image.jpg/",
  "createDate": "...Z", "updateDate": "...Z",
  "focalPoint": { "left": 0.5, "top": 0.4 },
  "crops": [ { "alias": "square", "width": 200, "height": 200, "coordinates": { "x1": 0.1, "y1": 0.0, "x2": 0.2, "y2": 0.3 } } ],
  "id": "...", "name": "My Image.jpg", "mediaType": "Image",
  "url": "/media/abc123/my-image.jpg", "extension": "jpg",
  "width": 1920, "height": 1080, "bytes": 123456,
  "properties": { "altText": "..." }
}
```

This is interface-contract order, as used by the query endpoint. A single item from `item/{id}` comes back in class order: `path, createDate, updateDate, id, name, mediaType, url, extension, width, height, bytes, properties, focalPoint, crops`.

**`url`**
- `IPublishedUrlProvider.GetMediaUrl(media)` with the default mode, which normally gives a relative URL like `/media/...` (`CoreDA/ApiMediaUrlProvider.cs`).

**`extension`, `width`, `height`, `bytes`**
- Read from `umbracoExtension`, `umbracoWidth`, `umbracoHeight` and `umbracoBytes` (`CoreDA/ApiMediaBuilder.cs`).
- Typed `string?` and `int?`; `null` when the property is absent, for example on a folder.

**`properties`**
- All media properties **except aliases starting with `umbraco`** (`ElementOnlyOutputExpansionStrategy.MapMediaProperties`, `skipUmbracoProperties = true`).

**`focalPoint` and `crops`**
- `ApiMediaWithCropsBuilderBase.Build` merges the crops picked locally (from a media picker) with the media's own `umbracoFile` image-cropper value, via `ImageCropperValue.Merge`:
  - Local values win.
  - Crops are matched by alias.
  - A local crop that has no coordinates takes the media's coordinates.
- The output comes from `DeliveryApiImageExtensions.GetImageFocalPoint` and `GetImageCrops` (`src/Umbraco.Infrastructure/Extensions/DeliveryApiImageExtensions.cs`).
- `focalPoint` is `null` when unset.
- `crops` is an array whenever the media has an `umbracoFile` cropper value; it is `null` only when neither side has crops.
- Crop `coordinates` may be `null`.
- The crops list follows the data type's configured crops (`ApplyConfiguration` in `src/Umbraco.Infrastructure/PropertyEditors/ImageCropperConfiguration.cs`).

**`path`** (response type only)
- Built as `"/" + join("/", names from the root down to the item, each lowercased) + "/"`.
- It uses the raw media **names**, not URL segments, so spaces are kept.

**`createDate` and `updateDate`**
- Present on the response type only.

**Media nested in content** (media picker 3) is `IApiMediaWithCrops`: no `path`, `createDate` or `updateDate`.

**Media from MNTP and multi URL picker** is plain `IApiMedia`: no `focalPoint` or `crops`.

### 1.3 Paged responses [src]
`src/Umbraco.Cms.Api.Common/ViewModels/Pagination/PagedViewModel.cs` → `{ "total": <long>, "items": [ ... ] }`.

### 1.4 Elements, blocks and links [src]
**`ApiElement`** (blocks, element picker): `{ "contentType", "id", "name", "properties" }`.
- `name` is `element.Name`. It was added in 18 and may be empty for block elements. [`Models/ApiElement.cs`]

**Block list**: `{ "items": [ { "content": ApiElement, "settings": ApiElement|null } ] }`.
- Empty or no value gives `{ "items": [] }`.
- Source: `InfraVC/BlockListPropertyValueConverter.cs:165`.

**Block grid**: `{ "gridColumns": 12, "items": [ ApiBlockGridItem ] }`.
- Each item is `{ "rowSpan", "columnSpan", "areaGridColumns", "areas": [ { "alias", "rowSpan", "columnSpan", "items": [...] } ], "content", "settings" }`.
- `gridColumns` defaults to 12 and `areaGridColumns` falls back to `gridColumns`.
- No value gives `{ "gridColumns": 12, "items": [] }`.
- Source: `InfraVC/BlockGridPropertyValueConverter.cs:100`.

**Single block** (`InfraVC/SingleBlockPropertyValueConverter.cs`): one `{ content, settings }` object, or `null`.

**`ApiLink`** (`Models/ApiLink.cs`), key order: `url, queryString, title, target, destinationId, destinationType, route, linkType, culture`.
- `linkType` is `"Content"`, `"Media"` or `"External"`.
- Content links have `url: null` and a `route`.
- Media and external links have `route: null`.

---

## 2. Routes, path resolution, Start-Item, culture, domains

### 2.1 Building `route` (`CoreDA/ApiContentRouteBuilder.cs`) [src]
1. Throws for anything that isn't Content.
2. `contentPath = IApiContentPathProvider.GetContentPath(content, culture)`. This calls `IPublishedUrlProvider.GetUrl(content, UrlMode.Relative, culture)` (`CoreDA/ApiContentPathProvider.cs`).
3. If preview is on and the content is unpublished in the culture, the path is `preview-{key:D}` (`Constants.DeliveryApi.Routing.PreviewContentPathPrefix = "preview-"`), with a trailing `/` when `AddTrailingSlash` is set.
4. If the URL is empty, whitespace or `"#"` (`Constants.Routing.Unroutable`), the builder falls back to `IDocumentUrlService.GetLegacyRouteFormat(key, culture, preview)`.
5. If the path is still invalid:
   - with preview on, it uses `preview-{key}`;
   - otherwise it returns **null**. The item is "un-routable", and the item endpoints give 404.
6. Trailing slash:
   - `RequestHandlerSettings.AddTrailingSlash` (default `true`) → `EnsureEndsWith('/')`;
   - otherwise `TrimEnd('/')`.

   The path also gets `EnsureStartsWith('/')`.
7. Root:
   - `content` itself if `Level == 1`;
   - otherwise the last key from `TryGetAncestorsKeys`, fetched from the cache, which is the top-most ancestor.
   - If there is no root, the route is null.
8. `rootPath = IDocumentUrlService.GetUrlSegment(root.Key, culture ?? variationCulture ?? "", preview) ?? ""`. This is the root's own URL segment with no slashes.
9. If `GlobalSettings.HideTopLevelNodeFromPath == false`:
   - `contentPath = contentPath.TrimStart("/" + rootPath).EnsureStartsWith('/')`.
   - The string `TrimStart` extension removes the prefix **repeatedly** and case-insensitively (`src/Umbraco.Core/Extensions/StringExtensions.Manipulation.cs:322`).
   - Either way `route.path` ends up **relative to the root**, and the root segment is carried in `startItem.path`.
10. The result is `ApiContentRoute(path, new ApiContentStartItem(root.Key, rootPath))`.

**Expected values from tests**

Default trailing slash, `HideTopLevelNodeFromPath = true` (the Umbraco default). Source: `tests/Umbraco.Tests.Integration/Umbraco.Core/DeliveryApi/Request/ApiContentRouteBuilderInvariantTests.cs`.
- First root → `path "/"`, `startItem.path "root-1"`.
- Other roots → `path "/root-3/"`, `startItem.path "root-3"`. Only the first root owns `/`.
- Children → `"/child-1/"`; grandchildren → `"/child-1/grandchild-1/"`.
- A root with a domain binding → `"/"`.
- With `AddTrailingSlash = false`: `"/"`, `"/root-2"` and `"/child-1"`.

`HideTopLevelNodeFromPath = false`:
- Root → `"/"` and child → `"/child-1/"`. The root segment is stripped.
- Unit tests (`tests/Umbraco.Tests.UnitTests/Umbraco.Core/DeliveryApi/ContentRouteBuilderTests.cs`) give the same values for both settings: root `"/"`, child `"/the-child"`, grandchild `"/the-child/the-grandchild"`, `startItem.path "the-root"`.

Variant content (`ApiContentRouteBuilderVariantTests.cs`):
- Segments are per culture, for example `"/child-1-en-us/"` with `startItem.path "root-1-en-us"`.
- The start item path is the culture-specific root segment.

Broken publish chain (`tests/Umbraco.Tests.AcceptanceTest/tests/DeliveryApi/BrokenPublishPathDeliveryApi.spec.ts`):
- If any ancestor is unpublished in the requested culture, the item returns 404.

### 2.2 Resolving `content/item/{*path}` (`D/Controllers/Content/ByRouteContentApiController.cs`) [src]
**Path decoding**
- The catch-all route value is passed through `DecodePath`, which runs `WebUtility.UrlDecode` **only if the value contains `%2F`**. ASP.NET has already decoded everything else.
- An empty path becomes `"/"`.

**Preview paths**
- A path starting with `/preview-` is handled only when the `Preview` header is set. It parses the GUID after the prefix, ignoring a trailing `/`, and calls `GetById`.
- Without the `Preview` header such a path → not found.

**Published paths: `ApiContentPathResolver.ResolveContentPath`**
1. `path.EnsureStartsWith("/")`.
2. `IRequestRoutingService.GetContentRoute(path)` (`D/Services/RequestRoutingService.cs`):
   - **If a Start-Item header resolves**, the route is `"{startItem.Id}{path}"`, for example `"1234/child-1"`.
   - Otherwise it builds `{scheme}://{host}{path}` and looks for a matching domain (`DomainUtilities.SelectDomain` over `IDomainCache.GetAll(false)`).
     - **No domain** → the route is `path` unchanged.
     - **Domain found** → the route is `"{domainContentId}{path relative to domain}"`, using `LocalPath` so it stays decoded. In addition, when the domain has a culture **and no valid Accept-Language was sent**, the `VariationContext` culture is switched to the domain culture; the segment is kept.
3. `IApiPublishedContentCache.GetByRoute(route)` (`CoreDA/ApiPublishedContentCache.cs`) → `ApiDocumentUrlService.GetDocumentKeyByRoute`:
   - A leading `"{int}/"` is parsed off as `documentStartNodeId`.
   - The rest goes to `IDocumentUrlService.GetDocumentKeyByRoute(route, culture, startNodeId, preview)`.
   - `culture` is the variation context culture. When null, the default language is used.

**`DocumentUrlService.GetDocumentKeyByRoute`** (`src/Umbraco.Core/Services/DocumentUrlService.cs:900`) [src]
- Segments come from `Split('/', RemoveEmptyEntries)`, so **trailing and duplicate slashes are irrelevant**.
- With a start node (Start-Item or domain):
  - unpublished start node in this culture → null;
  - no segments → the start node;
  - otherwise walk the children by URL segment, returning null if any step is unpublished in the culture.
- No segments and no start node → the **first root** (`GetTopMostRootKey`).
- `HideTopLevelNodeFromPath = true` and a single segment: first try roots whose segment matches (this covers non-first roots like `/root-3/`); otherwise fall through.
- The walk starts from:
  - `hideTopLevel = true` → the children of **all published roots**; first match wins;
  - `hideTopLevel = false` → the roots themselves.

  So with `hideTopLevel = false` and no Start-Item, the client must send `/root-1/child-1`, while the API emits `route.path` without the root segment. Clients are expected to send `Start-Item: route.startItem.path` together with `route.path`.
- Segment matching is `childUrlSegments.Contains(segment)`. That is an ordinal, **case-sensitive** comparison against the stored segments, which are lowercase. A node can have several segments, and any of them matches.
- Right-to-left cultures reverse the segment order unless `ForceCombineUrlPathLeftToRight` is set.

**Multi-root fallback in `ApiPublishedContentCache.GetByRoute`** [src]
- If there is no match and the route has exactly one `/` once trailing slashes are trimmed (for example `1234/root-2-segment`), retry with `"1234/"`.
- The retried result is accepted only if `content.UrlSegment == segment`.

**Results**
- Content found → member access check (401 or 403 with an empty body) → `200` with the built response.
  - If the builder returns null, `Ok(null)` is returned, which ASP.NET turns into **204**. [derived]
- Not found → `IRequestRedirectService.GetRedirectRoute(path)` (`D/Services/RequestRedirectService.cs`):
  - Redirect URL tracking is matched without the trailing slash.
  - If `HideTopLevelNodeFromPath` is false and there is a Start-Item, the start item's segment is prefixed.
  - Fallbacks are `"{startItemId}{path}"`, then `"{domainId}{path}"`.
  - On a match the response is a **301** (`RedirectPermanent(route.Path)`) with headers `Location-Start-Item-Path` and `Location-Start-Item-Id`.
  - Otherwise **404**, empty body.

### 2.3 Start-Item header (`D/Services/RequestStartItemProvider.cs`, `D/Filters/ValidateStartItemAttribute.cs`) [src]
- The header value is `Trim('/')`'d; empty or whitespace means no start item.
- Accepted values:
  - a GUID that matches a **root** key;
  - otherwise a URL segment matched case-insensitively (`InvariantEquals`) against `GetUrlSegment(rootKey, variationCulture, preview)` of each root.
- Only roots qualify, and they must be present in the cache for the current preview mode.
- Header present but not resolvable → `ValidateStartItem` returns **404 `NotFoundObjectResult("The Start-Item could not be found")`**. The string body is likely sent as text/plain. [derived]
- Effects:
  - item-by-path resolves relative to the start item;
  - a query with no `fetch` becomes `descendants` of the start item, which does not include the start item itself;
  - path-based `fetch` values resolve relative to the start item.

### 2.4 Culture and segment [src]
- `UmbracoRequestMiddleware` (`src/Umbraco.Web.Common/Middleware/UmbracoRequestMiddleware.cs:91`) initialises `VariationContext` to `X-UMB-CULTURE ?? default language ISO code`.
- `ContextualizeFromAcceptHeaders` then overrides culture and/or segment.
- Culture comes from `Accept-Language`, and only if it matches `^[\w-]*$` (`D/Services/RequestCultureService.cs`). Values like `en-GB,en;q=0.9` are **ignored**, which leaves the default language. The value is used as sent; cultures are compared case-insensitively.
- Segment comes from `Accept-Segment`, as sent.
- When a domain resolves during routing and no valid Accept-Language was sent, the domain culture is applied (see 2.2).
- The query index matches culture **lowercased**, or `"none"` for invariant documents (section 4).

---

## 3. Property values per editor

**Dispatch** [src]
- `PublishedPropertyType.ConvertInterToDeliveryApiObject` (`src/Umbraco.Core/Models/PublishedContent/PublishedPropertyType.cs:295`) calls `ConvertIntermediateToDeliveryApiObject(..., expanding)` when the converter implements `IDeliveryApiPropertyValueConverter`.
- Otherwise it uses the ordinary `ConvertIntermediateToObject`, so the value matches the Razor model value.
- With no converter at all, the intermediate value is returned.

**Null handling** [src]
- `CoreDA/ApiPropertyRenderer.cs`: if `property.HasValue()` is false, the value comes from `IPublishedValueFallback` with `Fallback.None`, which in practice is **`null`**.
- Converter fallback values for empty data (`""`, `0`, `false`) therefore normally **don't appear**; an empty property is `null`.
- The exception is converters whose `IsValue` treats a value as present. For example a true/false property with a stored `"0"` has a value and outputs `false`.

**Access control on nested content** [src]
- `src/Umbraco.Cms.Api.Common/Rendering/ElementOnlyOutputExpansionStrategy.cs`, `GetPropertyValue` / `ApplyContentAccessControl`.
- If a property value is `IApiContent` or `IEnumerable<IApiContent>`, each item is re-fetched through `IApiPublishedContentCache`.
- **Disallowed content types**, or content that can't be fetched, become `null` for a single value and are **dropped** from arrays.
- When expanding and the member has no access, `properties` is cleared to `{}`.

| Editor (alias) | Converter | Delivery API output |
|---|---|---|
| Textstring `Umbraco.TextBox`, Textarea `Umbraco.TextArea` | `src/Umbraco.Core/PropertyEditors/TextStringValueConverter.cs` (delivery-aware) | String. `{localLink}` and URLs are resolved through `HtmlLocalLinkParser` and `HtmlUrlParser`. Empty → `null` (HasValue false). |
| Rich text `Umbraco.RichText` (default) | `InfraVC/RteBlockRenderingValueConverter.cs:247` | `{"markup": "<p>..</p>", "blocks": [ApiBlockItem...]}`. Empty → `{"markup": "", "blocks": []}` (`RichTextModel.Empty()`). Markup processing is described below the table. |
| Rich text, `RichTextOutputAsJson = true` | `src/Umbraco.Infrastructure/DeliveryApi/ApiRichTextElementParser.cs` | A JSON tree, or `null` when empty or when parsing fails. The tree format is described below the table. |
| Markdown `Umbraco.MarkdownEditor` | `InfraVC/MarkdownEditorValueConverter.cs:150` | The **raw markdown string**, not rendered HTML. Empty → `""`, but in practice `null` through HasValue. |
| Content picker `Umbraco.ContentPicker` | `CoreVC/ContentPickerValueConverter.cs` | A single `IApiContent` object, or `null`. Aliases `umbracoInternalRedirectId` and `umbracoRedirect` are excluded. Always built with `ApiContentBuilder`: id, name, contentType, dates and route are always present. `properties` is `{}` unless the property is expanded (see section 5). There is never a `cultures` key. |
| Multinode treepicker `Umbraco.MultiNodeTreePicker` | `CoreVC/MultiNodeTreePickerValueConverter.cs` | **Always an array**, even with `maxNumber: 1`. Content source → `IApiContent[]`. Media source → `IApiMedia[]` (no crops; `properties` are subject to expansion). Member source → the string `"(unsupported)"`. Missing items are dropped. Only UDIs of the configured entity type count. |
| Media picker 3 `Umbraco.MediaPicker3` | `InfraVC/MediaPickerWithCropsValueConverter.cs` | **Always an array** of `IApiMediaWithCrops`, even in single mode, which holds at most one item. Each item merges local crops and focal point with the media's own. With `EnableLocalFocalPoint == false` the local focal point is dropped. Stored `"[]"` counts as no value → `null`. Media `properties` are `{}` unless expanded. |
| Multi URL picker `Umbraco.MultiUrlPicker` | `InfraVC/MultiUrlPickerValueConverter.cs` | **Always an array** of `ApiLink`, even with `maxNumber: 1`. Content links: title = link name, falling back to the content name; `route` from the route builder using the link's culture; `url: null`; `culture` set from the link. Media links: `url = mediaUrl + queryString`, `route: null`. External links: `url = url + queryString`. Deleted or unroutable targets are dropped. Stored `"[]"` → `null`. `maxNumber` is **not** applied in the Delivery API path. |
| Block list `Umbraco.BlockList` | `InfraVC/BlockListPropertyValueConverter.cs` | `{ "items": [{ "content": {...}, "settings": {...}\|null }] }`. Element properties are **always mapped** (`forceExpandProperties`). Pickers nested inside blocks still follow the expand rules. |
| Block grid `Umbraco.BlockGrid` | `InfraVC/BlockGridPropertyValueConverter.cs` | `{ "gridColumns", "items": [ { rowSpan, columnSpan, areaGridColumns, areas: [{alias,rowSpan,columnSpan,items}], content, settings } ] }` |
| Single block | `InfraVC/SingleBlockPropertyValueConverter.cs` | `{content, settings}`, or `null`. |
| Element picker `Umbraco.ElementPicker` | `CoreVC/ElementPickerValueConverter.cs` | An array of `ApiElement`, or null. |
| Image cropper `Umbraco.ImageCropper` | `InfraVC/ImageCropperValueConverter.cs` | `{ "url": <raw src>, "focalPoint": {left,top}\|null, "crops": [ {alias,width,height,coordinates\|null} ] }`. The crops come from the data type configuration. `url` is the stored `src` and is **not** passed through the URL provider. No `src` → null. |
| Tags `Umbraco.Tags` | `CoreVC/TagsValueConverter.cs` (not delivery-aware) | `string[]`. JSON or CSV storage, depending on config. |
| Dropdown `Umbraco.DropDown.Flexible` | `CoreVC/FlexibleDropdownPropertyValueConverter.cs` | `multiple` → `string[]`; otherwise a single `string` (the first value). |
| Checkbox list `Umbraco.CheckBoxList` | `CoreVC/CheckboxListValueConverter.cs` | `string[]` |
| Radio button list `Umbraco.RadioButtonList` | `CoreVC/RadioButtonListValueConverter.cs` | `string` |
| Date picker (legacy) `Umbraco.DateTime` | `CoreVC/DatePickerValueConverter.cs` | A `DateTime` with Kind **Unspecified**, so **no `Z`**, for example `"2024-03-01T00:00:00"`. |
| Date only / time only / date-time unspecified / date-time with time zone (v16+ editors) | `InfraVC/DateOnlyValueConverter.cs`, `TimeOnlyValueConverter.cs`, `DateTimeUnspecifiedValueConverter.cs`, `DateTimeWithTimeZoneValueConverter.cs` | `DateOnly` → `"2024-03-01"`; `TimeOnly` → `"14:30:00"`; `DateTime` (Unspecified) → `"2024-03-01T14:30:00"`; `DateTimeOffset` → `"2024-03-01T14:30:00+02:00"`. These are STJ's defaults. [derived] |
| Numeric `Umbraco.Integer` | `CoreVC/IntegerValueConverter.cs` | A JSON integer. |
| Decimal `Umbraco.Decimal` | `CoreVC/DecimalValueConverter.cs` | A JSON number. |
| Slider `Umbraco.Slider` | `CoreVC/SliderValueConverter.cs` | `decimal`, or with range enabled `{ "minimum": n, "maximum": n }` (`src/Umbraco.Core/Models/Range.cs`). |
| True/false `Umbraco.TrueFalse` | `CoreVC/YesNoValueConverter.cs` | `true` / `false` |
| Color picker `Umbraco.ColorPicker` | `CoreVC/ColorPickerValueConverter.cs` | `{ "value": "#ff0000", "label": "Red" }`. `[JsonPropertyName("value")]` on `Color` overrides camelCase. A non-JSON stored value gives `{value: v, label: v}`. `UseLabel` doesn't affect the output. |
| Eye dropper `Umbraco.ColorPicker.EyeDropper` | `CoreVC/EyeDropperValueConverter.cs` | `string` |
| Upload field `Umbraco.UploadField` | `CoreVC/UploadPropertyConverter.cs` | A string: the stored `src` path, for example `/media/xyz/file.pdf`. |
| Email `Umbraco.EmailAddress` | `CoreVC/EmailAddressValueConverter.cs` | `string` |
| Repeatable textstrings `Umbraco.MultipleTextstring` | `CoreVC/MultipleTextStringValueConverter.cs` | `string[]` |
| Member picker `Umbraco.MemberPicker` | `CoreVC/MemberPickerValueConverter.cs` | The literal string **`"(unsupported)"`**, whenever there is a value. |
| Member group picker `Umbraco.MemberGroupPicker` | `CoreVC/MemberGroupPickerValueConverter.cs` | `string[]` of group **names**, or null. |
| Any other JSON-storage editor | `InfraVC/JsonValueConverter.cs` (catch-all; excludes MediaPicker3) | The parsed JSON (`JsonNode`), or the raw string if it isn't JSON. |

**Rich text: HTML markup processing** (`src/Umbraco.Infrastructure/DeliveryApi/ApiRichTextMarkupParser.cs`)

Local links, in either the `{localLink:guid}` (with `type="document"`, matched case-insensitively) or the legacy `{localLink:umb://document/...}` form:
- `href` is set to `route.path` + any query or anchor suffix.
- `data-destination-id`, `data-destination-type`, `data-start-item-path`, `data-start-item-id` and `data-link-type="Content"` are added.
- `type` is removed.

Media links:
- `href` is set to the media URL, with `data-destination-*` and `data-link-type="Media"`.

Unresolvable links:
- `href` is removed.

Images with `data-udi`:
- `src` is set to the media URL, keeping the original query string (crop parameters). The HMAC signature is refreshed.
- `data-udi` and `data-caption` are removed.

Blocks:
- `<umb-rte-block data-content-key=..>` becomes `data-content-id="{guid}"`, and the block's children are removed.

Expected output from `tests/Umbraco.Tests.UnitTests/Umbraco.Infrastructure/DeliveryApi/ApiRichTextMarkupParserTests.cs`:

```html
<p><a href="/self/" title="itself" data-destination-id="eed5fc6b-96fd-45a5-a0f1-b1adfb483c2f" data-destination-type="someAlias" data-start-item-path="self" data-start-item-id="eed5fc6b-..." data-link-type="Content">itself</a></p>
```

**Rich text: JSON tree format** (`RichTextOutputAsJson = true`)

The root:

```json
{"tag":"#root","attributes":{},"elements":[ ... ],"blocks":[ApiBlockItem...]}
```

Each element is one of:
- `{"tag":"p","attributes":{...},"elements":[...]}`
- `{"tag":"#text","text":"..."}`

Content:
- Comments are dropped.
- Text nodes that are empty or contain only newlines are dropped, except whitespace between inline elements.

Attribute handling:
- `data-*` attributes are renamed without the `data-` prefix, unless an attribute with that name already exists.
- Content links: `href` is removed and `destinationId`, `destinationType`, `linkType: "Content"` and `route` (a route object) are added. The link culture comes from the `data-culture` attribute.
- Media links: `href` becomes the URL, plus `destinationId`, `destinationType` and `linkType: "Media"`.
- `img[data-udi]` gets `src` set to the media URL.
- `umb-rte-block*` elements get `content-id` set to a GUID.
- Nested elements carry `"$type"` discriminators (see section 0).

Tests: `tests/Umbraco.Tests.UnitTests/Umbraco.Core/DeliveryApi/RichTextParserTests.cs`.

**"Expanded" vs not, in summary:**
- Nested content (content picker, MNTP) is always output as a full `IApiContent` reference (id, name, contentType, createDate, updateDate, route), with `properties: {}` unless expanded.
- Nested media (media picker 3, MNTP media) always carries its core fields, plus crops for media picker 3, with `properties: {}` unless expanded.
- Elements (blocks, element picker, RTE blocks) always have their properties mapped.

---

## 4. Query endpoints

### 4.1 `GET content` (`D/Controllers/Content/QueryContentApiController.cs`, `D/Services/ApiContentQueryService.cs`, `D/Services/ApiContentQueryProvider.cs`, `D/Services/QueryBuilders/*`) [src]
**Parameters**
- `fetch` (string).
- `filter[]` and `sort[]`: repeated query params.
- `skip` (default 0) and `take` (default 10). Neither is validated nor capped.

**`fetch` (selector)**

Without `fetch` (null; an empty `fetch=` also binds to null [derived]):
- If a Start-Item resolved → descendants of the start item (`ancestorIds` contains its key).
- Otherwise → all content (`__IndexType == "content"`).

Matching:
- Prefixes are case-insensitive (`OrdinalIgnoreCase`): `ancestors:`, `children:`, `descendants:`.
- Anything else → **400**.

The value after the prefix is resolved by `QueryOptionBase.GetGuidFromQuery`:
- empty → no value;
- a GUID → used directly;
- otherwise treated as a **path**, routed with `RequestRoutingService.GetContentRoute` (honours Start-Item and domains) and then `ApiDocumentUrlService.GetDocumentKeyByRoute`.

Selector semantics:
- `children:X` → `parentId == X`. Top-level nodes are indexed with `parentId = 00000000-0000-0000-0000-000000000000`, so `children:00000000-0000-0000-0000-000000000000` returns the roots.
- `descendants:X` → `ancestorIds` contains X.
- `ancestors:X` → `itemId IN TryGetAncestorsKeys(X)`. X itself is not included; X at root → no results.
- An unresolvable id or path gives a selector with empty values → **200 with `{total: 0, items: []}`**, not 400. `ancestors:` on an unknown node behaves the same.

Index field names (`D/Indexing/**`): `itemId`, `parentId`, `ancestorIds`, `contentType` (StringRaw), `name` (StringAnalyzed, per culture), `createDate` (Date), `updateDate` (Date, per culture), `level` and `sortOrder` (Number), `sortName` (StringSortable, per culture).

**Always-added clauses** (`ApiContentQuerySelectorBuilder`):
- `culture IN (lower(requestCulture) | random-guid-if-empty, "none")`.
- `published == "y"`, unless preview.
- If member authorization is enabled: `protected == "n"` OR `protectedAccess IN ("u:{memberKey}", "r:{role}"...)`. Without member auth, protected content is always excluded from query results (`protected == "n"`).
- Disallowed content types are never indexed (`DeliveryApiContentIndexValueSetBuilder.cs:219`) and are also filtered again when loading.

**Filters** (`D/Querying/Filters/*`, `ApiContentQueryFilterBuilder.cs`)

General rules:
- Empty or whitespace filter strings are skipped.
- An unknown filter → **400**.
- Multiple `filter` params are **ANDed**.
- Comma-separated values within one filter are **ORed** (`GroupedOr`).

`contentType:alias1,alias2`:
- Exact, raw (case-sensitive) match.
- `contentType:!a,b` → `NOT (a OR b)`.
- The `contentType:` prefix is matched case-insensitively.

`name:foo`:
- Contains match (`ComplexWildcard "*foo"`; Examine appends the trailing wildcard) against the analyzed name, i.e. case-insensitive token matching.
- `name:!foo` → does not contain.
- `name:a,b` → contains a OR b.

`createDate<op><value>` and `updateDate<op><value>`:
- Regex `createDate(?<operator>[><:]{1,2})(?<value>.*)`, case-insensitive and **unanchored**.
- Operators: `:` equals, `>`, `>:` (>=), `<`, `<:` (<=). `:!` (not) is impossible here because `!` isn't in the operator character class.
- The value is parsed with `DateTime.TryParse` using the server culture, for example `2024-01-01` or `2024-01-01T10:00:00`.
- An unparsable date → the clause is silently skipped (**no 400**).
- An unknown operator → a "random GUID" filter that matches nothing → 200 with empty results.

**Sorts** (`D/Querying/Sorts/*`)
- Valid keys: `createDate:`, `updateDate:`, `level:`, `name:` (on the `sortName` field), `sortOrder:`. The prefix is case-insensitive.
- Direction: `asc` if the remainder **starts with "asc"** (case-sensitive); **anything else is descending**.
- Multiple sorts are appended in order (primary, then secondary).
- Unknown key → **400**.
- With no sort the order is the Lucene default, which is unspecified.

**400 bodies** (`ContentApiControllerBase.ApiContentQueryOperationStatusResult`) are `ProblemDetails`; `Type` defaults to `"Error"` (`src/Umbraco.Cms.Api.Common/Builders/ProblemDetailsBuilder.cs`):

```json
{"type":"Error","title":"Selector option not found","status":400,"detail":"The attempted 'fetch' option does not exist"}
{"type":"Error","title":"Filter option not found","status":400,"detail":"One of the attempted 'filter' options does not exist"}
{"type":"Error","title":"Sort option not found","status":400,"detail":"One of the attempted 'sort' options does not exist"}
```

`status` is filled in by ASP.NET; content type `application/problem+json`. [derived]

**Response**
- `{ total: results.TotalItemCount, items }`.
- Items are loaded by key in index order through `IApiPublishedContentCache.GetByIds`, which drops missing and disallowed items, then built with `ApiContentResponseBuilder`, which drops null routes.
- `total` is the index hit count, so it can exceed what was returned if items failed to load.
- Access check: `MemberAccessAsync` → `ProtectedAccess`. There is no per-item 401 or 403 in queries; protection is applied in the index query.
- Acceptance coverage: `tests/Umbraco.Tests.AcceptanceTest/tests/DeliveryApi/ContentDeliveryApi.spec.ts` lines 449–615. `filter=name:Child&sort=name:desc` returns Child N-1..0. Invalid fetch, filter or sort gives 400.

### 4.2 `GET media` (`D/Services/ApiMediaQueryService.cs`) [src]
This is an in-memory implementation; there is no index.

**`fetch`**
- **Required.** It must start with `children:` (case-insensitive). Anything else, including no `fetch` at all → **400 "Selector option not found"**.
- `children:` with nothing after it → empty result: 200, `total: 0`.
- `children:/` (only slashes) → root media items.
- `children:{guid}` → the children of that media item.
- `children:/folder/sub` → path resolution by media **name**, case-insensitive, one segment per level (`TryGetByPath`).
- An unknown parent → empty.

**Filters**
- Each must split on `:` into **exactly 2** parts; otherwise **400**. This applies to empty strings too, which are not skipped for media.
- `mediaType:Alias` → `ContentType.Alias == value`. The key is case-sensitive and the match is case-sensitive.
- `name:foo` → `Name.InvariantContains(foo)`.
- Anything else → 400.
- No negation and no comma OR.
- Multiple filters are ANDed.

**Sorts**
- Exactly 2 parts, keys `createDate`, `updateDate`, `name` (lowercased name), `sortOrder`. Keys are case-sensitive and there is **no `level`**.
- Anything else → 400.
- Direction: `asc` prefix, else descending.
- **Each sort calls `OrderBy` afresh, so the last sort wins**; there is no then-by.
- Default order: navigation order.

**Response**
- `{ total: count, items: [ IApiMediaWithCropsResponse ] }` with skip and take applied in memory.
- Media has no culture, preview, start-item or member access handling.
- Problem bodies are as for content, plus `"Unknown media query status"` for unexpected statuses.

---

## 5. `expand` and `fields` (v2): `src/Umbraco.Cms.Api.Common/Rendering/ElementOnlyOutputExpansionStrategy.cs`, `D/Rendering/RequestContextOutputExpansionStrategyV2.cs`

**Defaults** [src]
- `expand` absent → `""`, which expands nothing.
- `fields` absent → `"$all"`, which includes everything.
- Both are read from the raw query string.
- V2 is used for API versions other than 1, and when no version is resolved (`UmbracoBuilderExtensions.AddDeliveryApi`).

**Grammar** (`Node.Parse`) [src]
- `,` separates siblings and `[ ... ]` opens children.
- The root wraps the top-level items: `properties[a,b[properties[c]]]` → `root{ properties{ a, b{ properties{ c } } } }`.
- Errors (ArgumentException):
  - unequal `[` / `]` counts: "Value did not contain an equal number of start and end brackets";
  - a leading `[`: "Value cannot start with a bracket";
  - a literal `[]`: "Value cannot contain empty brackets".
- Text after a closing bracket is concatenated onto the node's key: `a[b]c` gives key `ac`.
- A parse error is rethrown as `ArgumentException("Could not parse the 'expand' parameter: ...")` from the scoped strategy's constructor. There is no Delivery API exception mapping, so the result is **HTTP 500**, an unhandled exception. [derived]

**Matching** (`GetNextProperties(node, alias)`) [src]
At any node, the child node for a property alias is:
- the node's `$all` child, if one exists; otherwise
- `node.properties.$all`, or `node.properties.<alias>`.

So `$all` works both at the top level (`expand=$all`) and inside `properties[...]`.

**Algorithm** (`MapProperties`) [src]
1. Keep stacks of the current expand node and the current include node.
2. **Top level** (stack depth 1): all properties are considered.
3. **Nested content or media** (stack depth > 1): if the current expand node is `null`, the nested item's `properties` are `{}`.
4. **Elements** (`MapElementProperties`, `forceExpandProperties = true`) are always mapped.
5. **Fields filter**: a property is skipped when the current include node has children and no child matches. An include node with no children (`fields=properties[picker]`) includes everything beneath it.
6. A property is "expanding" when its expand node isn't null. That flag is passed to converters, and nested `MapProperties` calls use the pushed node.

**Consequences**
- `expand=properties[$all]` expands every top-level picker **one level only**: the `$all` node has no children, so pickers nested inside the expanded item are not expanded.
- `expand=properties[picker[properties[$all]]]` expands `picker`, then all pickers inside it. `properties[picker[properties[nested]]]` expands only `nested` inside it.
- `fields=properties[title,picker]` keeps only `title` and `picker`.
- `fields=properties[picker[properties[title]]]` limits the expanded picker's properties to `title`. Fields never cause expansion: without `expand`, the picker still has `properties: {}`. This is tested in `OutputExpansionStrategy_CanLimitFieldsOfExpandedContent`.
- Pickers inside blocks expand only through the path to them, for example `expand=properties[myBlocks[properties[innerPicker]]]` (`OutputExpansionStrategy_CanExpandElementNestedContentPicker`).
- Unknown aliases are silently ignored.
- When expanding into protected content the member doesn't have access to, the content reference is kept with `properties: {}`.

Tests: `tests/Umbraco.Tests.UnitTests/Umbraco.Core/DeliveryApi/OutputExpansionStrategyV2Tests.cs` (and its base `OutputExpansionStrategyTestBase.cs`); `tests/Umbraco.Tests.Integration/Umbraco.Api.Delivery/Rendering/OutputExpansionStrategyAccessControlTests.cs`.

---

## 6. Item endpoints [src]

**`content/item/{id:guid}`** (`ByIdContentApiController.cs`)
1. `ApiPublishedContentCache.GetByIdAsync(id)` uses the published cache, or the draft cache with `Preview: true`.
2. Missing or disallowed type → **404** (empty body).
3. Member access → **401** (no or invalid member) or **403** (denied), empty bodies.
4. If the builder returns null (unroutable, e.g. the culture is unpublished or an ancestor is unpublished) → **404**.
5. Otherwise 200 with `IApiContentResponse`.

**`content/item/{*path}`**: see 2.2.
- Trailing slash doesn't matter.
- Path segments are case-sensitive.
- `%2F` encoding is supported.
- The culture comes from Accept-Language, a domain, or the default language.

**`content/items?id=a&id=b`** (`ByIdsContentApiController.cs`)
- Binds to a `HashSet<Guid>`, so **duplicates are removed**. The order is the first-seen request order. [derived: HashSet keeps insertion order when nothing is removed]
- Missing, unpublished or disallowed ids are **omitted**.
- Items whose route builder returns null are omitted.
- If **any** returned item fails the member access check, the **whole request** returns 401 or 403.
- Always 200 with a JSON **array**.

Acceptance tests:
- "returns only valid content items when some ids are invalid" → length 1.
- "returns only published..." → 1.

**`media/item/{id}`**
- `PublishedMediaCache.GetById` → missing → 404; otherwise 200.

**`media/item/{*path}`**
- Path by **media names**, case-insensitive. Empty segments are skipped.
- Missing → 404.

**`media/items?id=..`**
- Same HashSet semantics; missing ids are omitted.

**Disallowed content types**
- `DeliveryApiSettings.IsAllowedContentType` (`src/Umbraco.Core/Extensions/DeliveryApiSettingsExtensions.cs:45`):
  - if `AllowedContentTypeAliases` is non-empty → allowed only if listed (case-insensitive);
  - otherwise allowed unless listed in `DisallowedContentTypeAliases` (case-insensitive).
- Disallowed content gives 404 on item endpoints, is omitted from `items`, is never indexed for queries, and appears as `null` or is dropped when referenced by pickers.
- **Media has no allow or disallow list.**

**Unpublished and trashed content**
- Not in the published cache → 404 or omitted.
- Trashing unpublishes the content.
- With the `Preview: true` header (requires preview access via the API key; another agent covers auth), draft content is returned. Unpublished items get the route path `/preview-{guid}[/]`.

---

## 7. `DeliveryApiSettings` (`src/Umbraco.Core/Configuration/Models/DeliveryApiSettings.cs`, section `Umbraco:CMS:DeliveryApi`) [src]

**Top-level settings**

| Property | Type | Default |
|---|---|---|
| `Enabled` | bool | `false` |
| `PublicAccess` | bool | `true` |
| `ApiKey` | string? | `null` (used for non-public access and for preview) |
| `DisallowedContentTypeAliases` | ISet<string> | empty (ignored when `AllowedContentTypeAliases` is non-empty) |
| `AllowedContentTypeAliases` | ISet<string> | empty (**new**: an allow-list that takes precedence; overlap only logs a warning, see `Validation/DeliveryApiSettingsValidator.cs`) |
| `RichTextOutputAsJson` | bool | `false` |
| `Media.Enabled` | bool | `false` (no effect if the Delivery API itself is disabled) |
| `Media.PublicAccess` | bool | `true` (no effect if the top-level `PublicAccess` is false) |
| `MemberAuthorization` | MemberAuthorizationSettings? | `null` |
| `MemberAuthorization.AuthorizationCodeFlow` | `{ Enabled = false, LoginRedirectUrls = [], LogoutRedirectUrls = [] }`? | `null` |
| `MemberAuthorization.ClientCredentialsFlow` | `{ Enabled = false, AssociatedMembers = [ { UserName = "", ClientId = "", ClientSecret = "" } ] }`? | `null` |
| `OutputCache.Enabled` | bool | `false` |
| `OutputCache.ContentDuration` | TimeSpan | `00:01:00` |
| `OutputCache.MediaDuration` | TimeSpan | `00:01:00` |
| `OpenApi.GenerateContentTypeSchemas` | bool | `false` (typed per-content-type OpenAPI schemas) |

**`MemberAuthorizationIsEnabled()`**
- True if either the AuthorizationCodeFlow or the ClientCredentialsFlow is `Enabled`.
- This gates the protected-access clause in queries.

**Output cache** (`UmbracoBuilderExtensions.AddOutputCache`)
- Registered only when it is enabled and at least one duration is > 0.
- Content varies by `Accept-Language`, `Accept-Segment` and `Start-Item`; media varies by `Start-Item`.

**Relevant non-Delivery API settings**
- `GlobalSettings.HideTopLevelNodeFromPath` (default `true`).
- `RequestHandlerSettings.AddTrailingSlash` (default `true`).
- `GlobalSettings.ForceCombineUrlPathLeftToRight`.

---

## 8. Vendored contract cross-check (`/Users/adam/dev/crombolo-cms/packages/contracts/DeliveryApi.json`)

**Operations**
- The contract is `"version": "Latest"`, with 8 GET operations under `/umbraco/delivery/api/v2/...`.
- Content operations take `expand`, `fields`, and the headers `Accept-Language`, `Accept-Segment`, `Preview` (boolean) and `Start-Item`.
- Media operations take only `expand` and `fields`.
- The query endpoints document `skip` default 0, `take` default 10, and `filter` and `sort` as string arrays.

**Schemas**
- `IApiContentResponseModel` requires `contentType, createDate, updateDate, route, id, properties, cultures`; `name` is nullable and not required.
- `IApiMediaWithCropsResponseModel` requires `path, createDate, updateDate, id, name, mediaType, url, properties`.
- `ImageCropCoordinatesModel` and `ImageFocalPointModel` are numbers (`double`).

**Typed variant**
- The typed-schema variant, used when `OpenApi.GenerateContentTypeSchemas = true`, is shown in `tests/Umbraco.Tests.Integration/Umbraco.Api.Delivery/OpenApi/ExpectedContracts/typed-schemas-with-sample-types.json`.
- It uses `contentType` and `mediaType` as `oneOf` discriminators.
- Its schemas include `RichTextModel{markup,blocks}`, `ApiBlockListModel{items}` and `ApiImageCropperValueModel{url,focalPoint,crops}`.
