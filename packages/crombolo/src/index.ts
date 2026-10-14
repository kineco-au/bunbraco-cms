/**
 * The umbrella package a site installs.
 *
 * A site's `server.ts` is three lines:
 *
 *   import { crombolo } from '@crombolo/crombolo'
 *   import config from './crombolo.config.ts'
 *   Bun.serve(await crombolo(config))
 */
import {
  assertPortAvailable,
  type CromboloConfig,
  createServer,
  loadConfig,
  type ServerHandle,
} from '@crombolo/server'

export {
  type AssistantProvider,
  type BedrockOptions,
  bedrock,
  type ConverseInput,
  type ConverseResult,
} from '@crombolo/assistant'
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
} from '@crombolo/core'
export { allFormFields, formFieldType, storingFormFields } from '@crombolo/core'
export { type LiveNode, liveNodes } from '@crombolo/data'
export type {
  BlockGridArea,
  BlockGridItem,
  BlockItem,
  CSSProperties,
  ExtraAttributes,
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
  SeoHeadProps,
  SeoOverrides,
  SeoSiteDefaults,
  TypedElement,
} from '@crombolo/render'
export {
  type Context,
  createContext,
  Form,
  formAction,
  type ProviderProps,
  redirect,
  SeoHead,
  useContext,
  useId,
  usePage,
} from '@crombolo/render'
export type { Child } from '@crombolo/render/jsx-runtime'
export {
  // What a bundle's server half is written against; see `docs/17-bundles.md`.
  type AppAlias,
  type AzureMediaStoreOptions,
  type AzureSchemaStoreOptions,
  azureMediaStore,
  azureSchemaStore,
  type BundleCapability,
  type BundleDocuments,
  type BundleHost,
  type BundleLog,
  type BundleMethod,
  type BundleRedirectInput,
  type BundleRedirectRule,
  type BundleRedirects,
  type BundleRequest,
  type BundleSection,
  type CromboloConfig,
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
  type Principal,
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
} from '@crombolo/server'

/** Boots a site and returns what `Bun.serve` needs, the live-update WebSocket included. */
export async function crombolo(
  overrides: Partial<CromboloConfig> = {},
  cwd = process.cwd(),
): Promise<ServerHandle['serveOptions']> {
  const config = loadConfig(overrides, cwd)
  // The caller is about to serve these options, so fail here rather than after a
  // migration and a seed.
  await assertPortAvailable(config.port)
  const server = await createServer(config)
  return server.serveOptions
}
