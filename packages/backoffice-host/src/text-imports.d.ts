/**
 * `import x from './y.svg' with { type: 'text' }` — the file's contents as a
 * string, which Bun inlines at bundle time.
 *
 * TypeScript has no knowledge of a bundler's loaders, so the shape has to be
 * declared. Only `.svg` and `.css` are declared, and only `branding.ts` imports
 * either: a wider declaration would make a mistyped asset import compile.
 *
 * `branding.ts` references this file directly, rather than relying on it being
 * in anyone's `include`. The published package ships `.ts` source, so a
 * consumer's own `tsc` compiles `branding.ts` — and without the reference it
 * would compile it against no declaration and fail on an import it cannot
 * explain, in a file the consumer does not own.
 */
declare module '*.svg' {
  const contents: string
  export default contents
}

declare module '*.css' {
  const contents: string
  export default contents
}
