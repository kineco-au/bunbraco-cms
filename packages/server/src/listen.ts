/**
 * The check that runs before a process binds its port.
 *
 * A local run and the container stack serve the same port, so exactly one of them
 * can hold it — and "address in use" is then almost always the other one still
 * running. Bun's own `EADDRINUSE` arrives after the database has been migrated and
 * seeded, and says nothing about the likely cause, so this goes first.
 */
import { connect } from 'node:net'

/** Whether something is already listening on the port locally. */
export function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    // A connect attempt rather than a trial bind: binding and releasing leaves a
    // window in which the real listen can fail, which would be worse than the
    // problem being detected.
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (inUse: boolean) => {
      socket.destroy()
      resolve(inUse)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.setTimeout(timeoutMs, () => settle(false))
  })
}

/** Throws naming the likely cause when the port is taken. */
export async function assertPortAvailable(port: number): Promise<void> {
  if (!(await portInUse(port))) return
  throw new Error(
    `Port ${port} is already in use, so this server cannot start.\n` +
      `  The container stack publishes the same port — "bun run docker:down" stops it.\n` +
      `  Otherwise set PORT (or BUNBRACO_PORT for the stack) to something else.`,
  )
}
