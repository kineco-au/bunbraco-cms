/** The transaction the current async chain is inside, shared by the drivers and the lock managers. */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Cleared when its transaction ends, so work left running afterwards falls back to the pool. */
export interface AmbientTransaction<T> {
  owner: object
  tx: T | undefined
}

export const ambient = new AsyncLocalStorage<AmbientTransaction<unknown>>()

/** The open transaction this chain holds on `owner`'s connection, if any. */
export function ambientFor<T>(owner: object): T | undefined {
  const store = ambient.getStore()
  return store?.owner === owner ? (store.tx as T | undefined) : undefined
}

export function insideTransaction(): boolean {
  return ambient.getStore()?.tx !== undefined
}
