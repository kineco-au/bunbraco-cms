/**
 * The JSX runtime a site's views compile against.
 *
 * A site depends only on `@crombolo/crombolo`, so `jsxImportSource` must be `@crombolo/crombolo` —
 * pointing it at `@crombolo/render` would fail to resolve from the site's own
 * `node_modules`, which is exactly what the 5a exit test caught.
 */
export * from '@crombolo/render/jsx-runtime'
