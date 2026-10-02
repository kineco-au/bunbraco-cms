/**
 * The umbrella package a site installs.
 *
 * A site's `server.ts` is three lines:
 *
 *   import { bunbraco } from 'bunbraco'
 *   import config from './bunbraco.config.ts'
 *   Bun.serve(await bunbraco(config))
 */
import {
  assertPortAvailable,
  type BunbracoConfig,
  createServer,
  loadConfig,
  type ServerHandle,
} from '@bunbraco/server'

export {
  type AssistantProvider,
  type BedrockOptions,
  bedrock,
  type ConverseInput,
  type ConverseResult,
} from '@bunbraco/assistant'
export type {
  BlockGridArea,
  BlockGridItem,
  BlockItem,
  InnerHTML,
  Link,
  Navigation,
  PageProps,
  PublishedContent,
  PublishedElement,
  RedirectOptions,
  RedirectRule,
  RedirectTo,
  RequestMember,
  TypedElement,
} from '@bunbraco/render'
export { redirect } from '@bunbraco/render'
export type { Child } from '@bunbraco/render/jsx-runtime'
export {
  type AzureMediaStoreOptions,
  type AzureSchemaStoreOptions,
  azureMediaStore,
  azureSchemaStore,
  type BunbracoConfig,
  defineConfig,
  fileSystemMediaStore,
  loadConfig,
  type MediaStore,
  type S3MediaStoreOptions,
  type S3SchemaStoreOptions,
  type SchemaStore,
  s3MediaStore,
  s3SchemaStore,
} from '@bunbraco/server'

/** Boots a site and returns what `Bun.serve` needs, the live-update WebSocket included. */
export async function bunbraco(
  overrides: Partial<BunbracoConfig> = {},
  cwd = process.cwd(),
): Promise<ServerHandle['serveOptions']> {
  const config = loadConfig(overrides, cwd)
  // The caller is about to serve these options, so fail here rather than after a
  // migration and a seed.
  await assertPortAvailable(config.port)
  const server = await createServer(config)
  return server.serveOptions
}
