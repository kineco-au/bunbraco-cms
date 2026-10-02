/**
 * The JSX runtime a site's views compile against.
 *
 * A site depends only on `bunbraco`, so `jsxImportSource` must be `bunbraco` —
 * pointing it at `@bunbraco/render` would fail to resolve from the site's own
 * `node_modules`, which is exactly what the 5a exit test caught.
 */
export * from '@bunbraco/render/jsx-runtime'
