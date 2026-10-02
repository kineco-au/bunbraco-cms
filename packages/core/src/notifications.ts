/**
 * The `Umb-Notifications` response header. Note the name: it is NOT
 * `Umbraco-Notifications`. The backoffice reads it, renders toasts, and strips
 * it. Umbraco never sets it on GET.
 */
export const NOTIFICATIONS_HEADER = 'Umb-Notifications'

export type EventMessageType = 'Default' | 'Info' | 'Error' | 'Success' | 'Warning'

export interface EventMessage {
  message: string
  category: string
  type: EventMessageType
}

export function notificationsHeaderValue(messages: readonly EventMessage[]): string {
  return JSON.stringify(messages)
}

export function applyNotifications(
  headers: Headers,
  method: string,
  messages: readonly EventMessage[],
): void {
  if (method.toUpperCase() === 'GET') return
  if (messages.length === 0) return
  headers.set(NOTIFICATIONS_HEADER, notificationsHeaderValue(messages))
}
