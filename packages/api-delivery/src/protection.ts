/**
 * Members-only content: the nearest protected ancestor governs, as on the
 * site, and a member is let in by name or by one of their groups. Umbraco's
 * `PublicAccessChecker`, over rules read once per request.
 */

export interface ProtectionRule {
  /** The protected node's id: its own, or the ancestor whose rule covers it. */
  nodeId: number
  memberUserNames: string[]
  memberGroupNames: string[]
}

export interface DeliveryMember {
  key: string
  userName: string
  groups: string[]
  approved: boolean
  lockedOut: boolean
}

/** `allowed`; `unauthorized` (401: nobody, or a member who may not sign in); `forbidden` (403). */
export type Access = 'allowed' | 'unauthorized' | 'forbidden'

/** The rule governing a node by its path (`-1,1050,1063`), deepest first. Pure. */
export function ruleFor(
  path: string,
  rules: ReadonlyMap<number, ProtectionRule>,
): ProtectionRule | undefined {
  const ids = path.split(',').map(Number)
  for (let i = ids.length - 1; i >= 0; i--) {
    const rule = rules.get(ids[i] as number)
    if (rule) return rule
  }
  return undefined
}

/** What a caller may do with a node: a user name matches in any case, a group exactly. Pure. */
export function accessTo(
  path: string,
  rules: ReadonlyMap<number, ProtectionRule>,
  member: DeliveryMember | undefined,
): Access {
  const rule = ruleFor(path, rules)
  if (!rule) return 'allowed'
  if (!member?.approved || member.lockedOut) return 'unauthorized'
  const name = member.userName.toLowerCase()
  if (rule.memberUserNames.some((n) => n.toLowerCase() === name)) return 'allowed'
  if (rule.memberGroupNames.some((g) => member.groups.includes(g))) return 'allowed'
  return 'forbidden'
}
