# 049 — Light and dark in the back office

**Epic:** E — Cross-cutting · **Priority:** should · **Size:** M
**Depends on:** —

## Story

As an editor, I want to choose between the back office's light mode and a dark
mode, or have it follow my computer, and find it as I left it whenever and
wherever I sign in, so that I can work comfortably at any hour.

## Context

Some of this exists already, from the vendored Umbraco client:

- **Themes.** The client ships `light.css`, `dark.css` and `high-contrast.css`,
  and its theme context (`packages/core/themes/theme.context.js`) switches
  between them. The current user's profile offers the choice.
- **Memory.** The choice is kept in `localStorage` (`umb-theme-alias`): per
  browser, not per person. A new laptop, a cleared browser or a second browser
  starts in light again.
- **Branding.** Crombolo's palette (`plugin/branding/theme.css`, `docs/brand.md`)
  restyles light only. Dark is Umbraco's stock dark, purple accents and all, so
  it looks like a different product.

The gaps, then:

- **There is no crombolo dark.** It needs a dark palette from the same tokens:
  terracotta accents that clear contrast on dark surfaces, and the header and
  logo reworked for them.
- **The choice is buried in the profile** and nothing says it is there.
- **It is not remembered for the person,** only for the browser.
- **The page flashes.** It paints light first and switches once the client has
  booted. The login shell never boots the theme context at all, so it is always
  light.
- **There is no "follow the system" choice** that tracks
  `prefers-color-scheme` as it changes.

## Acceptance criteria

- [x] A crombolo dark palette in `theme.css`, alongside the light one, using the
      brand tokens and meeting WCAG AA for text and focus rings on every
      surface; `docs/brand.md` shows both
- [x] Three choices — Light, Dark, Match my system — offered from the user
      menu in the header, not only the profile, in plain words
- [x] "Match my system" follows `prefers-color-scheme`, including a change made
      while the back office is open
- [x] The choice is saved for the user on the server (the Management API's
      user-data area), so it follows them to another browser or device; a
      browser that has never chosen starts in light
- [x] Applied before the first paint, on the back office and on the login page,
      so a reload or a sign-in shows no flash of the other mode
- [x] High contrast stays available, and unbranded, for those who need it
- [x] The crombolo plugin's own screens (dashboards, the Changes and Audit views,
      the forms builder) read correctly in dark, with no hard-coded light
      colours
- [x] Tests: the preference round-trips through user data, the early script
      picks the right mode for each case, and a browser test switches modes,
      reloads, and finds the mode kept

## What was built

- **The palettes.** `plugin/branding/theme-dark.css` imports the vendored
  `dark.css` — `/umbraco/backoffice/…` is served wherever the back office is
  mounted — and warms it to the brand (`docs/brand.md` § Dark).
  `theme-system.css` is one line: that file under `(prefers-color-scheme:
  dark)`, so "Match my system" follows a change made while the page is open.
- **The themes.** `Crombolo.Theme.Dark` (overwriting `umb-dark-theme`) and
  `Crombolo.Theme.System` are `theme` extensions in `plugin/umbraco-package.json`,
  so Umbraco's theme context, its profile picker and its `localStorage` key work
  on them unchanged. High contrast is left as Umbraco's.
- **The switch.** `plugin/theme-switch.js`, a `headerApp`: Light, Dark and Match
  my system in a popover from the header. It sets the theme through the
  context, and keeps the choice in user data (`group: crombolo`, `identifier:
  theme`); on sign-in in another browser it restores it from there.
- **Before the first paint.** `backoffice-host/src/theme-early.ts` writes an
  inline script into the back office, login and standalone shells, after the
  light palette: it reads the same `localStorage` key and links the chosen
  stylesheet at once (`#crombolo-early-theme`). A browser that chose Umbraco's
  dark is moved to crombolo's. The switch removes the early link once the choice
  differs from it, so the two never fight. The login and standalone pages take
  their background from the theme rather than a fixed cream.
- **Crombolo's own screens** already used `--uui-color-*` tokens throughout;
  the SEO view's search-result title is now a token with a dark value, and the
  two-factor QR code keeps its white ground on purpose.
- **Tests.** `tests/theme.test.ts`: fourteen contrast pairs read from the CSS,
  the registrations, the early script against a stub page in every case, and
  both shells. `tests/browser/theme.browser.ts`: Dark from the header, kept
  across a reload, then Light again. Saving to user data is the existing
  `tests/users.test.ts` round trip.
