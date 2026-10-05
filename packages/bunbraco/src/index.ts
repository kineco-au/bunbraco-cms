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
// A view reads a form definition and a submission's state; both are domain
// types, so they come from core rather than from the renderer.
export type {
  FormCondition,
  FormFieldError,
  FormFieldType,
  FormSubmissionState,
  SchemaForm,
  SchemaFormField,
  SchemaFormGroup,
  SchemaFormPage,
  SubmittedValues,
} from '@bunbraco/core'
export { allFormFields, formFieldType, storingFormFields } from '@bunbraco/core'
export { type LiveNode, liveNodes } from '@bunbraco/data'
export type {
  BlockGridArea,
  BlockGridItem,
  BlockItem,
  FormFieldComponents,
  FormFieldRenderer,
  FormFieldRenderProps,
  FormProps,
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
export { Form, formAction, redirect } from '@bunbraco/render'
export type { Child } from '@bunbraco/render/jsx-runtime'
export {
  type AzureMediaStoreOptions,
  type AzureSchemaStoreOptions,
  azureMediaStore,
  azureSchemaStore,
  type BunbracoConfig,
  // What a bundle's server half is written against; see `docs/17-bundles.md`.
  type BundleCapability,
  type BundleDocuments,
  type BundleHost,
  type BundleLog,
  type BundleMethod,
  type BundleRedirectInput,
  type BundleRedirectRule,
  type BundleRedirects,
  type BundleRequest,
  type CustomEmailOptions,
  createServer,
  customEmail,
  defineConfig,
  type EmailAddress,
  type EmailAttachment,
  type EmailMessage,
  type EmailPort,
  type EmailResult,
  fileSystemMediaStore,
  loadConfig,
  logEmail,
  type MediaStore,
  mediaStoreFor,
  type PostmarkOptions,
  postmarkEmail,
  type ResendOptions,
  resendEmail,
  type S3MediaStoreOptions,
  type S3SchemaStoreOptions,
  type SchemaStore,
  type ServerBundle,
  type ServerBundleRoute,
  type ServerHandle,
  type SesOptions,
  s3MediaStore,
  s3SchemaStore,
  sesEmail,
  VERSION,
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
