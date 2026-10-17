/**
 * Every environment variable crombolo reads, declared once. `loadConfig` reads
 * through `setting`, and the configuration reference is generated from the list.
 */

export type SettingKind = 'string' | 'number' | 'boolean' | 'list' | 'enum'

export interface Setting {
  env: string
  kind: SettingKind
  /** As a reader would see it; omitted when there is none. */
  default?: string
  /** The accepted values, for an enum. */
  values?: readonly string[]
  section: string
  /** One or two plain sentences for a site owner. */
  description: string
  /** Never echoed. */
  secret?: boolean
  /** Who reads it; the server when unset. */
  appliesTo?: 'server' | 'cli' | 'both'
}

const SECTIONS = [
  'Server',
  'Database',
  'Sign-in and secrets',
  'Back office and bundles',
  'Schema',
  'Components',
  'Media',
  'E-mail',
  'Members',
  'Public site',
  'Remote',
  'Logging',
  'Command line',
  'AWS credentials',
] as const

/** Section headings, in display order. */
export const SETTING_SECTIONS: readonly string[] = SECTIONS

type Section = (typeof SECTIONS)[number]

const DECLARED = [
  // Server
  {
    env: 'NODE_ENV',
    kind: 'string',
    section: 'Server',
    description:
      '`production` turns off the development conveniences: generated admin passwords, writable schema files, e-mail to the console and relaxed upgrade checks.',
  },
  {
    env: 'PORT',
    kind: 'number',
    default: '8080',
    section: 'Server',
    description: 'The HTTP port. The application URL defaults to localhost on this port.',
  },
  {
    env: 'CROMBOLO_SITE_NAME',
    kind: 'string',
    default: 'Crombolo',
    section: 'Server',
    description: "The site's name, shown in the back office and used when a page is shared.",
  },
  {
    env: 'CROMBOLO_APPLICATION_URL',
    kind: 'string',
    default: 'http://localhost:<port>',
    section: 'Server',
    description: "The site's public address, which invitation and password-reset links point at.",
  },
  {
    env: 'CROMBOLO_ROLE',
    kind: 'enum',
    values: ['all', 'api', 'web'],
    default: 'all',
    section: 'Server',
    description:
      'What this process serves: everything, the back office and its API, or the public site alone. Splitting needs Postgres; a misspelt role stops the server.',
  },
  {
    env: 'CROMBOLO_NODE_ID',
    kind: 'string',
    default: 'host:pid',
    section: 'Server',
    description:
      "This node's name, stamped on schema syncs, content changes and the upgrade history.",
  },
  {
    env: 'CROMBOLO_MAX_REQUEST_BODY_MB',
    kind: 'number',
    default: '32',
    section: 'Server',
    description: 'The largest request body the server reads, media uploads included.',
  },
  {
    env: 'CROMBOLO_INSECURE_COOKIES',
    kind: 'boolean',
    default: 'false',
    section: 'Server',
    description:
      'Drops the secure cookie requirements, for a plain-http host that is not localhost.',
  },

  // Database
  {
    env: 'CROMBOLO_DB',
    kind: 'enum',
    values: ['sqlite', 'postgres'],
    default: 'sqlite',
    section: 'Database',
    description: 'Which database engine the site runs on.',
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_SQLITE_FILE',
    kind: 'string',
    default: 'crombolo.sqlite',
    section: 'Database',
    description: 'The SQLite file, relative to the site, or `:memory:`.',
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_POSTGRES_URL',
    kind: 'string',
    section: 'Database',
    description: 'The Postgres connection string. Required when the database is Postgres.',
    secret: true,
    appliesTo: 'both',
  },
  {
    env: 'DATABASE_URL',
    kind: 'string',
    section: 'Database',
    description: 'Used as the Postgres connection string when `CROMBOLO_POSTGRES_URL` is unset.',
    secret: true,
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_LOCK_TIMEOUT_SECONDS',
    kind: 'number',
    default: '15',
    section: 'Database',
    description: 'How long a content write waits for another before it gives up and answers 503.',
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_PG_DUMP',
    kind: 'string',
    section: 'Database',
    description:
      'A shell command that backs up Postgres before a repair, an upgrade or a purge. It is given `CROMBOLO_BACKUP_STAMP` and `CROMBOLO_BACKUP_REASON`; without it those commands need `--backup-taken`.',
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_UPGRADE_POLICY',
    kind: 'enum',
    values: ['strict', 'pending-allowed'],
    default: 'strict in production, else pending-allowed',
    section: 'Database',
    description: 'Whether findings that need a person stop an upgrade.',
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_VERSION_CLEANUP',
    kind: 'boolean',
    default: 'false',
    section: 'Database',
    description: 'Runs the hourly clean-up of old content versions.',
  },
  {
    env: 'CROMBOLO_VERSION_CLEANUP_KEEP_ALL_DAYS',
    kind: 'number',
    default: '7',
    section: 'Database',
    description:
      "The clean-up keeps every version newer than this many days. A content type's own policy wins.",
  },
  {
    env: 'CROMBOLO_VERSION_CLEANUP_KEEP_LATEST_DAYS',
    kind: 'number',
    default: '90',
    section: 'Database',
    description: "After that, it keeps each day's latest version for this many days.",
  },
  {
    env: 'CROMBOLO_AUDIT_RETENTION_DAYS',
    kind: 'number',
    default: '365',
    section: 'Database',
    description: 'How many days the audit log keeps an entry. `0` keeps them all.',
  },

  // Sign-in and secrets
  {
    env: 'CROMBOLO_ADMIN_LOGIN',
    kind: 'string',
    default: 'admin@crombolo.local',
    section: 'Sign-in and secrets',
    description: 'The login of the first administrator.',
  },
  {
    env: 'CROMBOLO_ADMIN_PASSWORD',
    kind: 'string',
    default: 'generated in development',
    section: 'Sign-in and secrets',
    description:
      "The first administrator's password, used only when the database is created. Unset in production, the site is set up in the browser.",
    secret: true,
  },
  {
    env: 'CROMBOLO_SETUP_CODE',
    kind: 'string',
    section: 'Sign-in and secrets',
    description:
      'Guards "Set up your new site" in production: 16 or more characters, chosen by you. Remove it once the site is set up.',
    secret: true,
  },
  {
    env: 'CROMBOLO_API_CLIENT_ID',
    kind: 'string',
    section: 'Sign-in and secrets',
    description:
      'An API client an unattended install creates in the administrators group; it starts `crombolo-back-office-`. With it, no password administrator is created unless `CROMBOLO_ADMIN_PASSWORD` is set.',
    appliesTo: 'both',
  },
  {
    env: 'CROMBOLO_API_CLIENT_SECRET',
    kind: 'string',
    section: 'Sign-in and secrets',
    description:
      "That client's secret, set together with the id. It is used once, when the client is created.",
    secret: true,
  },
  {
    env: 'CROMBOLO_LOCAL_ADMIN',
    kind: 'boolean',
    default: 'false',
    section: 'Sign-in and secrets',
    description:
      'Creates the password administrator even when an API client is set. Honoured only on localhost.',
  },
  {
    env: 'CROMBOLO_SECRET_KEY',
    kind: 'string',
    section: 'Sign-in and secrets',
    description:
      "Seals secrets kept in the database, such as a webhook's headers and two-factor keys; 32 or more characters. Features that need it are not offered without it.",
    secret: true,
  },
  {
    env: 'CROMBOLO_USERNAME_IS_EMAIL',
    kind: 'boolean',
    default: 'true',
    section: 'Sign-in and secrets',
    description: "A back office user's login is their e-mail address.",
  },

  // Back office and bundles
  {
    env: 'CROMBOLO_BACKOFFICE_PATH',
    kind: 'string',
    default: '/crombolo',
    section: 'Back office and bundles',
    description: 'Where the back office is served.',
  },
  {
    env: 'CROMBOLO_CSS_DIR',
    kind: 'string',
    default: 'css',
    section: 'Back office and bundles',
    description: 'The stylesheets the Settings section edits, served at `/css/`.',
  },
  {
    env: 'CROMBOLO_SCRIPTS_DIR',
    kind: 'string',
    default: 'scripts',
    section: 'Back office and bundles',
    description: 'The scripts the Settings section edits, served at `/scripts/`.',
  },
  {
    env: 'CROMBOLO_APPLY_BUNDLE_CONTENT',
    kind: 'boolean',
    default: 'true',
    section: 'Back office and bundles',
    description:
      'Installing a bundle from the Marketplace also applies the schema, components and content it carries.',
  },
  {
    env: 'CROMBOLO_RUNTIME_INSTALLS',
    kind: 'boolean',
    default: 'true, false with a schema store',
    section: 'Back office and bundles',
    description:
      'The Packages section installs and removes packages on the running site. Off, they are added to `package.json` and deployed.',
  },
  {
    env: 'CROMBOLO_MARKETPLACE_URL',
    kind: 'string',
    default: 'https://www.npmjs.com/search?q=keywords%3Acrombolo-bundle',
    section: 'Back office and bundles',
    description: 'Where the Marketplace sends someone browsing for bundles.',
  },
  {
    env: 'CROMBOLO_PACKAGE_KEYWORD',
    kind: 'string',
    default: 'crombolo-bundle',
    section: 'Back office and bundles',
    description: 'The npm keyword a bundle publishes under to be found by the Marketplace.',
  },
  {
    env: 'CROMBOLO_NPM_REGISTRY',
    kind: 'string',
    default: 'https://registry.npmjs.org',
    section: 'Back office and bundles',
    description: 'The registry the Marketplace searches, such as a mirror.',
  },

  // Schema
  {
    env: 'CROMBOLO_SCHEMA_DIR',
    kind: 'string',
    default: 'schema',
    section: 'Schema',
    description: 'Where the schema files live. Nothing is synced when the folder is absent.',
  },
  {
    env: 'CROMBOLO_SCHEMA_REVISION',
    kind: 'string',
    default: '0',
    section: 'Schema',
    description: 'Set by a deploy, to order deploys of the same schema version.',
  },
  {
    env: 'CROMBOLO_SCHEMA_CACHE_DIR',
    kind: 'string',
    default: '<temp>/crombolo-schema',
    section: 'Schema',
    description: 'Where a schema kept in cloud storage is copied to when the server starts.',
  },
  {
    env: 'CROMBOLO_SCHEMA_WRITABLE',
    kind: 'boolean',
    default: 'true unless production or with a schema store',
    section: 'Schema',
    description: 'Whether the back office may change the schema files.',
  },
  {
    env: 'CROMBOLO_SYNC_SCHEMA_AT_BOOT',
    kind: 'boolean',
    default: 'true',
    section: 'Schema',
    description:
      'Syncs the schema files when the server starts. Turn it off when a deploy runs `crombolo types sync` itself.',
  },

  // Components
  {
    env: 'CROMBOLO_COMPONENTS_DIR',
    kind: 'string',
    default: 'components',
    section: 'Components',
    description: "Where the site's page views and components live.",
  },
  {
    env: 'CROMBOLO_COMPONENTS_CACHE_DIR',
    kind: 'string',
    default: '.crombolo/components',
    section: 'Components',
    description:
      'Where components are copied so that an edit is picked up without a restart. Inside the site, and cleared when the server starts.',
  },
  {
    env: 'CROMBOLO_COMPONENTS_GATE_MS',
    kind: 'number',
    default: '5000, 500 in development',
    section: 'Components',
    description: 'How often a node looks for changed components, in milliseconds.',
  },
  {
    env: 'CROMBOLO_COMPONENTS_SWAP_MS',
    kind: 'number',
    default: '10000, 0 in development',
    section: 'Components',
    description:
      'The least time between two changes being picked up, in milliseconds. A save made in the back office is never held back by it.',
  },
  {
    env: 'CROMBOLO_COMPONENTS_GENERATION_LIMIT',
    kind: 'number',
    default: '250',
    section: 'Components',
    description:
      'How many changes a node picks up before it stops taking more and keeps serving the last.',
  },
  {
    env: 'CROMBOLO_COMPONENTS_KEEP',
    kind: 'number',
    default: '3, all in development',
    section: 'Components',
    description: 'How many earlier copies are kept on disk, for an instant return to one.',
  },
  {
    env: 'CROMBOLO_RENDER_TIMEOUT_MS',
    kind: 'number',
    default: '10000',
    section: 'Components',
    description:
      'How long a page may take to render, layouts included, before it fails, in milliseconds. `0` for no limit.',
  },

  // Media
  {
    env: 'CROMBOLO_MEDIA_DIR',
    kind: 'string',
    default: 'media',
    section: 'Media',
    description: 'Where uploaded files live on this disk, served at `/media/`.',
  },
  {
    env: 'CROMBOLO_MEDIA_STORE',
    kind: 'enum',
    values: ['filesystem', 's3', 'azure'],
    default: 'filesystem',
    section: 'Media',
    description: 'Where media files are kept. An unrecognised value falls back to the file system.',
  },
  {
    env: 'CROMBOLO_MEDIA_PUBLIC_URL',
    kind: 'string',
    section: 'Media',
    description:
      'A CDN in front of the media folder: browsers are sent there instead of being served by this server.',
  },
  {
    env: 'CROMBOLO_MEDIA_S3_BUCKET',
    kind: 'string',
    section: 'Media',
    description: 'S3: the bucket.',
  },
  {
    env: 'CROMBOLO_MEDIA_S3_REGION',
    kind: 'string',
    section: 'Media',
    description: "S3: the bucket's region.",
  },
  {
    env: 'CROMBOLO_MEDIA_S3_ENDPOINT',
    kind: 'string',
    section: 'Media',
    description: 'S3: the endpoint, for an S3-compatible store such as R2, Spaces or MinIO.',
  },
  {
    env: 'CROMBOLO_MEDIA_S3_ACCESS_KEY_ID',
    kind: 'string',
    section: 'Media',
    description: "S3: the access key. Unset, the client's usual credentials are used.",
  },
  {
    env: 'CROMBOLO_MEDIA_S3_SECRET_ACCESS_KEY',
    kind: 'string',
    section: 'Media',
    description: "S3: the access key's secret.",
    secret: true,
  },
  {
    env: 'CROMBOLO_MEDIA_S3_SESSION_TOKEN',
    kind: 'string',
    section: 'Media',
    description: 'S3: a session token, for temporary credentials.',
    secret: true,
  },
  {
    env: 'CROMBOLO_MEDIA_S3_PREFIX',
    kind: 'string',
    section: 'Media',
    description: 'S3: a folder inside the bucket to keep media under.',
  },
  {
    env: 'CROMBOLO_MEDIA_S3_PUBLIC_URL',
    kind: 'string',
    section: 'Media',
    description: 'S3: a public address for the bucket, such as a CDN, that browsers are sent to.',
  },
  {
    env: 'CROMBOLO_MEDIA_S3_PRESIGN_SECONDS',
    kind: 'number',
    section: 'Media',
    description:
      'S3: sends browsers to a signed bucket address that lasts this many seconds. Use this or a public address, not both.',
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_ACCOUNT',
    kind: 'string',
    section: 'Media',
    description: 'Azure: the storage account.',
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_CONTAINER',
    kind: 'string',
    default: 'media',
    section: 'Media',
    description: 'Azure: the blob container.',
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_KEY',
    kind: 'string',
    section: 'Media',
    description: "Azure: the account's key.",
    secret: true,
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_SAS',
    kind: 'string',
    section: 'Media',
    description: 'Azure: a shared access signature, instead of the key.',
    secret: true,
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_ENDPOINT',
    kind: 'string',
    section: 'Media',
    description: 'Azure: the blob endpoint, for a sovereign cloud or a local emulator.',
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_PREFIX',
    kind: 'string',
    section: 'Media',
    description: 'Azure: a folder inside the container to keep media under.',
  },
  {
    env: 'CROMBOLO_MEDIA_AZURE_PUBLIC_URL',
    kind: 'string',
    section: 'Media',
    description:
      'Azure: a public address for the container, such as a CDN, that browsers are sent to.',
  },

  // E-mail
  {
    env: 'CROMBOLO_EMAIL_PROVIDER',
    kind: 'enum',
    values: ['none', 'resend', 'postmark', 'ses', 'custom'],
    default: 'none',
    section: 'E-mail',
    description:
      'How e-mail is sent. Without one, invitations, password resets and form e-mails are unavailable; development prints messages to the console.',
  },
  {
    env: 'CROMBOLO_EMAIL_FROM',
    kind: 'string',
    section: 'E-mail',
    description: 'The sender address. Every provider needs it, and verifies its domain.',
  },
  {
    env: 'CROMBOLO_EMAIL_FROM_NAME',
    kind: 'string',
    section: 'E-mail',
    description: 'The name shown beside the sender address.',
  },
  {
    env: 'CROMBOLO_EMAIL_API_KEY',
    kind: 'string',
    section: 'E-mail',
    description:
      "The provider's key: Resend's API key, Postmark's server token, or a bearer token for a custom endpoint.",
    secret: true,
  },
  {
    env: 'CROMBOLO_EMAIL_URL',
    kind: 'string',
    default: "the provider's own API",
    section: 'E-mail',
    description:
      'The address messages are sent to. Required for a custom endpoint, an override for the others. Must be HTTPS unless it is on this machine.',
  },
  {
    env: 'CROMBOLO_EMAIL_POSTMARK_STREAM',
    kind: 'string',
    default: 'outbound',
    section: 'E-mail',
    description: 'Postmark: the message stream to send on.',
  },
  {
    env: 'CROMBOLO_EMAIL_SES_REGION',
    kind: 'string',
    default: 'AWS_REGION',
    section: 'E-mail',
    description: 'SES: the region to send from.',
  },
  {
    env: 'CROMBOLO_EMAIL_SES_ACCESS_KEY_ID',
    kind: 'string',
    default: 'AWS_ACCESS_KEY_ID',
    section: 'E-mail',
    description: 'SES: the access key, when it differs from the standard AWS one.',
  },
  {
    env: 'CROMBOLO_EMAIL_SES_SECRET_ACCESS_KEY',
    kind: 'string',
    default: 'AWS_SECRET_ACCESS_KEY',
    section: 'E-mail',
    description: "SES: that access key's secret.",
    secret: true,
  },
  {
    env: 'CROMBOLO_EMAIL_SES_CONFIGURATION_SET',
    kind: 'string',
    section: 'E-mail',
    description: 'SES: the configuration set that governs sending.',
  },
  {
    env: 'CROMBOLO_EMAIL_SES_ENDPOINT',
    kind: 'string',
    default: 'the regional SES address',
    section: 'E-mail',
    description: 'SES: a private endpoint to send through instead.',
  },

  // Members
  {
    env: 'CROMBOLO_ALLOW_MEMBER_REGISTRATION',
    kind: 'boolean',
    default: 'false',
    section: 'Members',
    description: 'Lets visitors register as members of the site.',
  },
  {
    env: 'CROMBOLO_MEMBER_REGISTRATION_TYPE',
    kind: 'string',
    default: 'Member',
    section: 'Members',
    description: 'The member type a registration creates, by alias.',
  },
  {
    env: 'CROMBOLO_MEMBER_REGISTRATION_GROUPS',
    kind: 'list',
    section: 'Members',
    description: 'The member groups a registration joins, separated by commas.',
  },
  {
    env: 'CROMBOLO_MEMBER_SESSION_MINUTES',
    kind: 'number',
    default: '20160',
    section: 'Members',
    description: "How long a member's sign-in lasts, in minutes. The default is 14 days.",
  },
  {
    env: 'CROMBOLO_MAX_FAILED_PASSWORD_ATTEMPTS',
    kind: 'number',
    default: '5',
    section: 'Members',
    description: 'Failed member sign-ins before the member is locked out. `0` never locks out.',
  },

  // Public site
  {
    env: 'CROMBOLO_INDEXABLE',
    kind: 'boolean',
    default: 'true',
    section: 'Public site',
    description:
      'Off keeps search engines out entirely, for a staging site: robots are refused, there is no sitemap and every page asks not to be indexed.',
  },
  {
    env: 'CROMBOLO_SITEMAP',
    kind: 'boolean',
    default: 'true',
    section: 'Public site',
    description: 'Serves `/sitemap.xml`.',
  },
  {
    env: 'CROMBOLO_TRACK_REDIRECTS',
    kind: 'boolean',
    default: 'true',
    section: 'Public site',
    description: 'Renaming or moving a page records a redirect from the address it had.',
  },
  {
    env: 'CROMBOLO_DELIVERY_API',
    kind: 'boolean',
    default: 'false',
    section: 'Public site',
    description: 'Turns on the Delivery API, which serves content as JSON.',
  },
  {
    env: 'CROMBOLO_DELIVERY_API_KEY',
    kind: 'string',
    section: 'Public site',
    description:
      'The key that unlocks a private Delivery API, and previews of unpublished content.',
    secret: true,
  },
  {
    env: 'CROMBOLO_DELIVERY_API_PUBLIC',
    kind: 'boolean',
    default: 'true',
    section: 'Public site',
    description: 'Off, every Delivery API request needs the key.',
  },
  {
    env: 'CROMBOLO_DELIVERY_API_MEDIA',
    kind: 'boolean',
    default: 'false',
    section: 'Public site',
    description: 'The Delivery API serves media as well as content.',
  },

  // Remote
  {
    env: 'CROMBOLO_REMOTE_ENABLED',
    kind: 'boolean',
    default: 'false',
    section: 'Remote',
    description: 'Lets `crombolo pull` and `crombolo push` reach this site.',
  },
  {
    env: 'CROMBOLO_REMOTE_ENVIRONMENT',
    kind: 'string',
    default: 'production',
    section: 'Remote',
    description:
      'The name this site goes by for pull and push: lower case letters, digits and dashes.',
  },
  {
    env: 'CROMBOLO_REMOTE_PROTECTED',
    kind: 'boolean',
    default: 'true',
    section: 'Remote',
    description: 'A push here needs the protected-push permission.',
  },
  {
    env: 'CROMBOLO_REMOTE_APPROVALS',
    kind: 'boolean',
    default: 'false',
    section: 'Remote',
    description:
      'A push to a protected site waits for someone else to approve it. Needs `CROMBOLO_SECRET_KEY`.',
  },
  {
    env: 'CROMBOLO_REMOTE_MAX_UPLOAD_GB',
    kind: 'number',
    default: '50',
    section: 'Remote',
    description:
      'The largest push or media file a client may upload, in gigabytes. Every other request keeps the usual body limit.',
  },

  // Logging
  {
    env: 'CROMBOLO_LOGS_DIR',
    kind: 'string',
    default: 'logs',
    section: 'Logging',
    description: 'Where log files are written, a file a day, read by the back office log viewer.',
  },
  {
    env: 'CROMBOLO_LOG_LEVEL',
    kind: 'enum',
    values: ['trace', 'debug', 'info', 'warning', 'error', 'fatal'],
    default: 'info',
    section: 'Logging',
    description: 'The least severe level logged.',
  },
  {
    env: 'CROMBOLO_LOG_TO_CONSOLE',
    kind: 'boolean',
    default: 'true',
    section: 'Logging',
    description: 'Log events are also printed to the console.',
  },
  {
    env: 'CROMBOLO_TRACE_REQUESTS',
    kind: 'boolean',
    default: 'false',
    section: 'Logging',
    description: 'Prints a line on the console as each request arrives and as it is answered.',
  },
  {
    env: 'CROMBOLO_HEAP_INTERVAL_SECONDS',
    kind: 'number',
    default: '0',
    section: 'Logging',
    description:
      'Every this many seconds, prints the memory in use and the requests in flight. `0` is off.',
  },

  // Command line
  {
    env: 'CROMBOLO_BOOT_ATTEMPTS',
    kind: 'number',
    default: '10',
    section: 'Command line',
    description:
      'How many times `crombolo start` tries to start the site, waiting longer each time, before it exits.',
    appliesTo: 'cli',
  },
  {
    env: 'CROMBOLO_ACTOR',
    kind: 'string',
    default: 'the account running the command',
    section: 'Command line',
    description: 'Who the audit log records for a command, for a pipeline acting for someone.',
    appliesTo: 'cli',
  },
  {
    env: 'CROMBOLO_BUNDLE_PASSPHRASE',
    kind: 'string',
    section: 'Command line',
    description: 'The passphrase for an encrypted content file, instead of being asked for it.',
    secret: true,
    appliesTo: 'cli',
  },
  {
    env: 'CROMBOLO_DEBUG',
    kind: 'boolean',
    default: 'false',
    section: 'Command line',
    description: 'Adds the stack trace to an unexpected error.',
    appliesTo: 'cli',
  },
  {
    env: 'CROMBOLO_TEMPLATES_DIR',
    kind: 'string',
    default: 'the templates the command line ships',
    section: 'Command line',
    description: 'Where `crombolo init` finds its site templates, for trying a changed one.',
    appliesTo: 'cli',
  },

  // AWS credentials
  {
    env: 'AWS_REGION',
    kind: 'string',
    section: 'AWS credentials',
    description: 'The AWS region, for SES e-mail and the Bedrock assistant when they set none.',
  },
  {
    env: 'AWS_PROFILE',
    kind: 'string',
    section: 'AWS credentials',
    description: 'The AWS profile the Bedrock assistant signs in with.',
  },
  {
    env: 'AWS_ACCESS_KEY_ID',
    kind: 'string',
    section: 'AWS credentials',
    description: 'A static AWS access key, for SES e-mail and the Bedrock assistant.',
  },
  {
    env: 'AWS_SECRET_ACCESS_KEY',
    kind: 'string',
    section: 'AWS credentials',
    description: "That access key's secret.",
    secret: true,
  },
  {
    env: 'AWS_SESSION_TOKEN',
    kind: 'string',
    section: 'AWS credentials',
    description: 'A session token, for temporary AWS credentials.',
    secret: true,
  },
] as const satisfies readonly (Setting & { section: Section })[]

export const SETTINGS: readonly Setting[] = DECLARED

/** The name of a declared setting. */
export type SettingName = (typeof DECLARED)[number]['env']

const NAMES: ReadonlySet<string> = new Set(SETTINGS.map((entry) => entry.env))

/** The raw environment value of a declared setting; unset is undefined. */
export function setting(name: SettingName): string | undefined {
  if (!NAMES.has(name)) throw new Error(`${name} is not a declared setting.`)
  return Bun.env[name]
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function shownDefault(entry: Setting): string {
  if (entry.default === undefined) return '—'
  return /\s/.test(entry.default) ? cell(entry.default) : `\`${cell(entry.default)}\``
}

function shownKind(entry: Setting): string {
  if (entry.kind === 'enum') return (entry.values ?? []).map((value) => `\`${value}\``).join(', ')
  if (entry.kind === 'boolean') return '`true` / `false`'
  return entry.kind
}

function shownDescription(entry: Setting): string {
  const notes: string[] = []
  if (entry.appliesTo === 'cli') notes.push('Read by the command line.')
  if (entry.appliesTo === 'both') notes.push('Read by the server and the command line.')
  if (entry.secret) notes.push('Kept secret: never printed.')
  return cell([entry.description, ...notes].join(' '))
}

/** The settings reference: a table per section, in display order. */
export function settingsMarkdown(): string {
  const parts: string[] = []
  for (const section of SETTING_SECTIONS) {
    const entries = SETTINGS.filter((entry) => entry.section === section)
    if (entries.length === 0) continue
    parts.push(`### ${section}`, '')
    parts.push('| Setting | Takes | Default | Description |', '| --- | --- | --- | --- |')
    for (const entry of entries)
      parts.push(
        `| \`${entry.env}\` | ${shownKind(entry)} | ${shownDefault(entry)} | ${shownDescription(entry)} |`,
      )
    parts.push('')
  }
  return parts.join('\n').trimEnd()
}
