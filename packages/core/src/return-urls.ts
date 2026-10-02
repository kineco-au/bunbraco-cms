/** Validation for `returnUrl` values, which are attacker-supplied by nature. */

/**
 * The origin a candidate is resolved against. Any host but this one means the
 * value escaped the site, whatever it looked like as text.
 */
const PROBE = 'https://return-url.invalid'

/**
 * A `returnUrl` reduced to a path on this site, or nothing.
 *
 * Both callers take the value from a query string and hand it to a browser to
 * navigate to, so this is the difference between resuming a sign-in and bouncing
 * the person somewhere else with a session in hand. Text comparisons are not
 * enough: browsers read `\` as `/` and strip tabs and newlines before resolving,
 * so `/\evil.com` and `/<tab>/evil.com` both leave the site while starting with a
 * single slash. Resolving against a probe origin and insisting the result stayed
 * there is the check that holds, and it rejects `javascript:` on the way through
 * because that parses to no origin at all.
 *
 * The value returned is the re-serialised path, so what the caller stores cannot
 * be read differently by whatever parses it next.
 */
export function localReturnUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  // By code point rather than a regex: a control character written into one is
  // exactly what a linter is right to stop, and this says the same thing plainly.
  const cleaned = [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
  if (!cleaned.startsWith('/')) return undefined
  try {
    const resolved = new URL(cleaned, PROBE)
    if (resolved.origin !== PROBE) return undefined
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return undefined
  }
}
