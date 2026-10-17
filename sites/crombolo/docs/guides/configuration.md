---
title: Configuration
summary: Where a site's settings live, which source wins when two disagree, and the handful of settings you set first.
order: 1
---

A new site runs with nothing set. The defaults are chosen so that `bun start` on a laptop gives you a working site on SQLite, and everything you change from there is either a line in `crombolo.config.ts` or an environment variable.

This page covers how the two fit together and the settings most sites set first. Every setting, with its default, is in the [configuration reference](/docs/reference/configuration/).

## The config file

Every site has a `crombolo.config.ts` beside its `package.json`. It exports the result of `defineConfig`:

```ts
import { defineConfig } from '@crombolo/crombolo'

export default defineConfig({
  siteName: 'My Site',
  applicationUrl: 'https://www.example.com',
})
```

The file is TypeScript, so your editor completes the setting names and checks their types. The server reads it when it starts, and so does the command line, so a command run in the site's folder acts on the same database and folders the site uses.

Some settings can only go in the file, because they are code rather than a value:

| Setting | What it is |
| --- | --- |
| `bundles` | the server side of the bundles this site runs |
| `redirects` | redirect rules, built with `redirect()` |
| `email` | an e-mail provider, built with `resendEmail()`, `postmarkEmail()`, `sesEmail()` or `customEmail()` |
| `mediaStore` | where uploaded files go, built with `s3MediaStore()` or `azureMediaStore()` |
| `memberIdentityProviders`, `backofficeIdentityProviders` | sign-in through Entra, AWS Identity Center or any OpenID Connect provider |
| `assistant` | the optional AI helper in the back office |

`bundles` in particular has no environment variable on purpose: code reaches a running site only through a reviewed, deployed change to this file.

## Which value wins

Each setting is resolved in this order:

1. **A value in `crombolo.config.ts`.** If the file sets it, that is the value.
2. **The environment.** Otherwise, the matching environment variable, if it is set.
3. **The default.** Otherwise, the built-in default.

So the file is for what is true of the site everywhere, and the environment is for what differs between your laptop, staging and production. A setting you want to change per environment should stay out of the file.

Bun reads a `.env` file in the site's folder when it starts, so local settings can live there. `crombolo init` lists `.env` in `.gitignore`; keep it that way, since it is where passwords end up.

### Development and production

`NODE_ENV=production` is the switch between the two. In development, which is anything else, crombolo is helpful: it generates and prints an administrator's password, lets the back office write schema files, prints e-mail to the console, and lets an upgrade proceed with items still waiting for a person. In production it does none of those. Always set `NODE_ENV=production` on a deployed site.

## The settings you set first

### The database

SQLite is the default, in a file called `crombolo.sqlite` in the site's folder. To use Postgres, set two variables:

```sh
CROMBOLO_DB=postgres
CROMBOLO_POSTGRES_URL=postgres://crombolo:secret@db.internal:5432/my-site
```

`DATABASE_URL` is used if `CROMBOLO_POSTGRES_URL` is not set, which suits platforms that provide one. To keep SQLite somewhere else, set `CROMBOLO_SQLITE_FILE`.

On Postgres, anything that changes the database in bulk takes a backup first, and it needs to know how. Set `CROMBOLO_PG_DUMP` to a command that takes one, or pass `--backup-taken` to say you already have. [Operations](/docs/guides/operations/) has the detail.

### The secret key

```sh
CROMBOLO_SECRET_KEY=a-long-random-value-of-at-least-32-characters
```

The secret key seals secrets the site keeps in its database, such as the headers a webhook sends and two-factor sign-in keys, and it is needed for push approvals. A feature that needs it is not offered until it is set. Generate it once per environment, keep it in your secret store, and never commit it.

### The first administrator

On your own machine an administrator is created for you. In production, choose one of two ways:

- **From a pipeline.** Set `CROMBOLO_ADMIN_LOGIN` and `CROMBOLO_ADMIN_PASSWORD`. They are used only when the database is created; a later start never resets the password.
- **From the browser.** Leave the password unset and set `CROMBOLO_SETUP_CODE` to a value of 16 or more characters that only you know. The first visit to the back office asks for your name, e-mail, password and that code. Remove the code once the site is set up.

[Deploying](/docs/guides/deploying/) covers both, and the option of signing in only through an identity provider.

### The site's address

```sh
CROMBOLO_APPLICATION_URL=https://www.example.com
```

The public address of the site, which invitation and password-reset links point at. It defaults to `http://localhost` on the site's port, which is right on your machine and wrong everywhere else. The port itself is `PORT`, 8080 by default.

### E-mail

E-mail is off until you choose a provider. Without one the site still works: inviting users, resetting a forgotten password and form e-mails are shown as unavailable rather than failing. Pick a provider from the environment:

```sh
CROMBOLO_EMAIL_PROVIDER=resend          # or postmark, ses, custom
CROMBOLO_EMAIL_FROM=no-reply@example.com
CROMBOLO_EMAIL_FROM_NAME="My Site"
CROMBOLO_EMAIL_API_KEY=re_...
```

Or in the config file:

```ts
import { defineConfig, resendEmail } from '@crombolo/crombolo'

export default defineConfig({
  email: resendEmail({
    apiKey: process.env.RESEND_KEY ?? '',
    from: { email: 'no-reply@example.com', name: 'My Site' },
  }),
})
```

Every provider is reached over HTTPS; there is no SMTP. `crombolo status` shows which provider the site will use.

## Checking what a site sees

```sh
bunx crombolo status
```

`status` reads the configuration, opens the database without changing it, and reports what it finds: the database, the schema, pending upgrades, e-mail, and anything that would stop the site working. It exits with code 20 when something is wrong, so a deploy step can rely on it.

## Where next

- The [configuration reference](/docs/reference/configuration/) lists every setting, its default and what it does
- [Deploying](/docs/guides/deploying/) puts these settings together for production
