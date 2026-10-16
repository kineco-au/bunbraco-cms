/**
 * Members-only pages: who a protection rule lets in, and which protected
 * branches that leaves a member — one check for rendering a page, the Delivery
 * API and site search. The nearest protected ancestor governs, as in Umbraco.
 */

/** Who a protected page lets in: members named by user name, or in a named group. */
export interface MemberRule {
  memberUserNames: readonly string[]
  memberGroupNames: readonly string[]
}

/** The member asking, by user name and the names of their groups. */
export interface RuleMember {
  username: string
  groups: readonly string[]
}

/** Whether a rule lets a member in. Names and groups both match in any case. Pure. */
export function memberMayOpen(rule: MemberRule, member: RuleMember | undefined): boolean {
  if (!member) return false
  const name = member.username.toLowerCase()
  if (rule.memberUserNames.some((n) => n.toLowerCase() === name)) return true
  const groups = new Set(member.groups.map((g) => g.toLowerCase()))
  return rule.memberGroupNames.some((g) => groups.has(g.toLowerCase()))
}

/**
 * The protected nodes a member may not open (`denied`) and may (`allowed`). A
 * page is closed to them when the nearest protected node on its path is
 * denied: a denied branch can hold an allowed one below it. Pure.
 */
export function branchAccess(
  rules: ReadonlyArray<MemberRule & { nodeId: number }>,
  member: RuleMember | undefined,
): { denied: number[]; allowed: number[] } {
  const denied: number[] = []
  const allowed: number[] = []
  for (const rule of rules) (memberMayOpen(rule, member) ? allowed : denied).push(rule.nodeId)
  return { denied, allowed }
}
