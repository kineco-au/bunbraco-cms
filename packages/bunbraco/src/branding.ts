/**
 * The brand, for anything that draws it rather than serves it.
 *
 * Its own subpath rather than part of `bunbraco`'s main entry, because the one
 * consumer is a browser bundle: importing the umbrella's index would pull the
 * server, the data layer and the renderer into a page that only wants a logo.
 * Nothing here imports anything but the brand files themselves.
 *
 *   import { brandPalette, logoSvg } from 'bunbraco/branding'
 */
export {
  type BrandPalette,
  brandPalette,
  faviconSvg,
  logoSvg,
} from '@bunbraco/backoffice-host/branding'
