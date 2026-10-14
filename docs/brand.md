# Brand

The mark (the terracotta disc and its cream arcs) and the full logo live in
`packages/backoffice-host/plugin/branding/` as SVG: `favicon.svg` is the mark,
`logo-header.svg` and `logo-surface.svg` the full logo. They are the one source;
`crombolo/branding` exports the same bytes, and `docs/brand/` holds PNG renders
of both. The palette is declared once, as the `--crombolo-*` tokens in
`theme.css`, and taken from the logo: the disc's terracotta is `orange-deep`, the
wordmark's cocoa is `cocoa`, and the lighter roles are tints of the same hue
chosen so text on them clears WCAG AA (`tests/brand-exports.test.ts`).

## Where each file is used

| File | Used for |
| --- | --- |
| `favicon.svg` | The back office tab icon, and `faviconSvg` in `crombolo/branding` |
| `logo-header.svg` | The back office header and sign-in card, and `logoSvg` in `crombolo/branding` |
| `logo-surface.svg` | The same logo where Umbraco shows its alternative logo |
| `icon-mark.js` | The mark in one colour, served in place of the Umbraco icon in the icon registry |
| `backdrop.svg` | The sign-in backdrop, with the mark as a watermark |
| `sites/crombolo/components/shared/logo.tsx` | The product site's mark and favicon |

The marks were traced from the master artwork, so the arcs and the wordmark are
paths: no font is needed to draw them. `tests/branding.test.ts` holds every file
to the same disc and arcs, so a new mark has to land in all of them at once.

## The palette

| Token | Value | Role |
| --- | --- | --- |
| `--crombolo-orange` | `#da987c` | Accent fill: buttons, the selected item, the header bar |
| `--crombolo-orange-light` | `#e2ae98` | Hover fill, never text |
| `--crombolo-orange-deep` | `#cb6f48` | The logo's terracotta: focus ring and the disc |
| `--crombolo-orange-text` | `#974b2b` | The only orange that reads as body text |
| `--crombolo-cocoa` | `#54321f` | Ink: text, icons, text on the accent, the wordmark |
| `--crombolo-cream` | `#fff7ea` | The page ground behind white panels |

The logo's own terracotta can't carry text: white on it is 3.8:1 and cocoa on it
is 3.0:1. So the accent fill is a lighter tint that cocoa text clears AA on, at
4.7:1. The product site's stylesheet (`sites/crombolo/css/site.css`) uses the
same family, with its own `--terracotta-*` tokens.
