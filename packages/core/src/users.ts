/** Rules for backoffice users' credentials, as Umbraco's `UserPasswordConfigurationSettings` defaults them. */

export interface PasswordConfiguration {
  minimumPasswordLength: number
  requireNonLetterOrDigit: boolean
  requireDigit: boolean
  requireLowercase: boolean
  requireUppercase: boolean
}

export const DEFAULT_PASSWORD_CONFIGURATION: PasswordConfiguration = {
  minimumPasswordLength: 10,
  requireNonLetterOrDigit: false,
  requireDigit: false,
  requireLowercase: false,
  requireUppercase: false,
}

export function isValidPassword(
  password: string,
  config: PasswordConfiguration = DEFAULT_PASSWORD_CONFIGURATION,
): boolean {
  if (password.length < config.minimumPasswordLength) return false
  if (config.requireDigit && !/\d/.test(password)) return false
  if (config.requireLowercase && !/[a-z]/.test(password)) return false
  if (config.requireUppercase && !/[A-Z]/.test(password)) return false
  if (config.requireNonLetterOrDigit && !/[^A-Za-z0-9]/.test(password)) return false
  return true
}

/** A password that satisfies `config`, for a reset the backoffice shows once. */
export function generateUserPassword(
  config: PasswordConfiguration = DEFAULT_PASSWORD_CONFIGURATION,
): string {
  const letters = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
  const all = `${letters}23456789`
  const length = Math.max(config.minimumPasswordLength, 12)
  const random = crypto.getRandomValues(new Uint32Array(length))
  const chars = Array.from(random, (n) => all[n % all.length] as string)
  // One of each class keeps any combination of requirements satisfied
  chars[0] = 'abcdefghijkmnopqrstuvwxyz'[(random[0] ?? 0) % 25] as string
  chars[1] = 'ABCDEFGHJKLMNPQRSTUVWXYZ'[(random[1] ?? 0) % 24] as string
  chars[2] = '23456789'[(random[2] ?? 0) % 8] as string
  if (config.requireNonLetterOrDigit) chars[3] = '!@#$%*-_+='[(random[3] ?? 0) % 10] as string
  return chars.join('')
}

/** A plausible e-mail address; Umbraco's check is no stricter. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(email)
}
