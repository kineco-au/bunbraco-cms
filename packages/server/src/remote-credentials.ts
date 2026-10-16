/**
 * A developer's sign-ins to remotes (story 108): kept in the operating system's
 * keychain (macOS Keychain, Windows Credential Manager, libsecret) through
 * `Bun.secrets`, keyed by the remote's origin, never in the site's folder.
 * Shared by the CLI's commands and a lazily-fetching local media store.
 */

export const KEYCHAIN_SERVICE = 'crombolo-remote'

export interface Keychain {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

/** The operating system's keychain. */
export function osKeychain(): Keychain {
  return {
    get: (name) => Bun.secrets.get({ service: KEYCHAIN_SERVICE, name }),
    set: (name, value) => Bun.secrets.set({ service: KEYCHAIN_SERVICE, name, value }),
    delete: async (name) => {
      await Bun.secrets.delete({ service: KEYCHAIN_SERVICE, name })
    },
  }
}

/** A keychain in memory, for tests and machines without one. */
export function memoryKeychain(): Keychain {
  const values = new Map<string, string>()
  return {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value)
    },
    delete: async (name) => {
      values.delete(name)
    },
  }
}

export interface RemoteSignIn {
  accessToken: string
  refreshToken: string
  /** Milliseconds since the epoch. */
  expiresAt: number
  tokenUrl: string
  clientId: string
  /** Who approved it, for `whoami`. */
  user?: string
}

const keyOf = (origin: string) => new URL(origin).origin

export async function readSignIn(
  keychain: Keychain,
  origin: string,
): Promise<RemoteSignIn | undefined> {
  const stored = await keychain.get(keyOf(origin))
  if (!stored) return undefined
  try {
    return JSON.parse(stored) as RemoteSignIn
  } catch {
    return undefined
  }
}

export const saveSignIn = (keychain: Keychain, origin: string, signIn: RemoteSignIn) =>
  keychain.set(keyOf(origin), JSON.stringify(signIn))

export const forgetSignIn = (keychain: Keychain, origin: string) => keychain.delete(keyOf(origin))

/**
 * A usable access token: the stored one, or a refreshed one when it is within a
 * minute of expiring. Undefined when there is no sign-in, or the remote refused
 * the refresh — the person signs in again.
 */
export async function freshAccessToken(
  keychain: Keychain,
  origin: string,
  http: typeof fetch = fetch,
  force = false,
): Promise<string | undefined> {
  const signIn = await readSignIn(keychain, origin)
  if (!signIn) return undefined
  if (!force && signIn.expiresAt - Date.now() > 60_000) return signIn.accessToken
  const response = await http(signIn.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: signIn.refreshToken,
      client_id: signIn.clientId,
    }).toString(),
  })
  if (!response.ok) return undefined
  const tokens = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }
  await saveSignIn(keychain, origin, {
    ...signIn,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  })
  return tokens.access_token
}
