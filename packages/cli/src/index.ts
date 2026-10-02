/**
 * The command line's own public surface: the starter-template catalogue.
 *
 * The commands themselves are the `bunbraco` binary, not an API; what a caller
 * outside this package needs is the catalogue `init --template` reads, which
 * `scripts/build-template.ts` also uses to regenerate the committed bundles.
 */
export * from './templates.ts'
