/**
 * Where crombolo's Management API differs from Umbraco's contract on purpose.
 * `OpenApi.json` stays exactly Umbraco's, so a re-copy from a new release is a
 * clean diff; each difference is listed here with its reason, and applied when
 * the contract is loaded and when it is served.
 */
export interface ContractOverride {
  /** The schema under `components.schemas` it changes. */
  schema: string
  story: string
  reason: string
  apply(schema: Record<string, unknown>): void
}

export const CONTRACT_OVERRIDES: readonly ContractOverride[] = [
  {
    schema: 'CreateMemberRequestModel',
    story: '035',
    reason:
      'A member who will only ever sign in through an identity provider is created with no password, as external sign-in creates one.',
    apply(schema) {
      schema.required = ((schema.required as string[] | undefined) ?? []).filter(
        (field) => field !== 'password',
      )
    },
  },
]

/** The contract with every override applied, leaving the one given untouched. */
export function applyOverrides<T extends { components: { schemas: Record<string, unknown> } }>(
  spec: T,
): T {
  const copy = structuredClone(spec)
  for (const override of CONTRACT_OVERRIDES) {
    const schema = copy.components.schemas[override.schema] as Record<string, unknown> | undefined
    if (!schema) throw new Error(`The contract has no schema ${override.schema} to override`)
    override.apply(schema)
  }
  return copy
}
