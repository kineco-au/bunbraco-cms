/**
 * Answering a content import's conflicts, and running it, from the Changes
 * dashboard. docs/content-transfer.md, "In the backoffice".
 *
 * The answers are stored, not written beside the bundle: an installed bundle
 * lives in `node_modules`, which a redeploy replaces and other nodes do not
 * share. They are laid over the bundle's own `resolutions.json` at import, and
 * can be downloaded as that file to commit with it.
 */
import {
  type Db,
  type PendingTransfer,
  type TransferAnswer,
  TransferAnswerRepository,
} from '@crombolo/data'
import { isResolution, nodeResolutionProblems, type Resolution } from '@crombolo/transfer'
import { BackupRequiredError } from './backup.ts'
import {
  CommandError,
  checkBundleContent,
  installBundleContent,
  PassphraseError,
  pendingResolutionsFile,
} from './bundle-install.ts'
import type { CromboloConfig } from './config.ts'

export interface PendingTransferView {
  bundleId: string
  label: string | null
  checkedAt: string
  publish: boolean
  allowMissingBlobs: boolean
  answers: Array<Pick<TransferAnswer, 'nodeKey' | 'handle' | 'resolution' | 'answeredBy'>>
}

/** The imports waiting on the dashboard, with the answers given so far. */
export async function pendingTransfers(db: Db): Promise<PendingTransferView[]> {
  const repo = new TransferAnswerRepository(db)
  const out: PendingTransferView[] = []
  for (const pending of await repo.allPending())
    out.push({
      bundleId: pending.bundleId,
      label: pending.label,
      checkedAt: pending.checkedAt.toISOString(),
      publish: pending.publish,
      allowMissingBlobs: pending.allowMissingBlobs,
      answers: (await repo.answers(pending.bundleId)).map(
        ({ nodeKey, handle, resolution, answeredBy }) => ({
          nodeKey,
          handle,
          resolution,
          answeredBy,
        }),
      ),
    })
  return out
}

const HANDLE = /^(\*|[A-Za-z][A-Za-z0-9_]*(@[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)?)$/
const NODE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What is wrong with an answer as sent, if anything. Pure. */
export function answerProblems(body: Record<string, unknown>): string[] {
  const nodeKey = typeof body.nodeKey === 'string' ? body.nodeKey : ''
  const handle = typeof body.handle === 'string' ? body.handle : ''
  if (!NODE_KEY.test(nodeKey)) return ['The answer names no item.']
  if (!HANDLE.test(handle)) return ['The answer names no field.']
  if (body.resolution === null) return []
  if (typeof body.resolution !== 'string' || !isResolution(body.resolution))
    return ['That is not one of the answers on offer.']
  return nodeResolutionProblems(nodeKey, { [handle]: body.resolution }).length > 0
    ? ['Only a whole item can be left out.']
    : []
}

export interface TransferActionContext {
  db: Db
  config: CromboloConfig
  /** Who is acting, recorded with each answer. */
  user: string
  /** After an import lands: the published cache was built before it. */
  onApplied(): void
}

const unreadable = (error: CommandError) =>
  Response.json(
    {
      ok: false,
      message: 'This bundle can no longer be read on this server.',
      detail: error.problems,
    },
    { status: 409 },
  )

async function recheck(
  ctx: TransferActionContext,
  pending: PendingTransfer,
  passphrase: string | undefined,
) {
  const result = await checkBundleContent(ctx.db, ctx.config, {
    bundle: pending.target,
    under: pending.under ?? undefined,
    publish: pending.publish,
    allowMissingBlobs: pending.allowMissingBlobs,
    by: ctx.user,
    passphrase,
  })
  return {
    ok: true,
    outstanding: result.check.outstanding.length,
    blocking: result.check.outstanding.filter((f) => f.kind === 'blocking').length,
    publishRefusals: result.publishRefusals.length,
  }
}

/**
 * `<bundleId>/answer`, `/missing-files`, `/check`, `/import` and
 * `/resolutions`. Undefined for anything else.
 */
export async function handleTransferAction(
  request: Request,
  action: string,
  ctx: TransferActionContext,
): Promise<Response | undefined> {
  const match = /^([^/]+)\/(answer|missing-files|check|import|resolutions)$/.exec(action)
  if (!match) return undefined
  const bundleId = decodeURIComponent(match[1] as string)
  const verb = match[2] as string
  const repo = new TransferAnswerRepository(ctx.db)
  const pending = await repo.pending(bundleId)
  if (!pending)
    return Response.json(
      { ok: false, message: 'Nothing is waiting to be imported from this bundle.' },
      { status: 404 },
    )

  try {
    if (verb === 'resolutions' && request.method === 'GET') {
      const file = (await pendingResolutionsFile(ctx.db, ctx.config, bundleId)) as string
      return new Response(file, {
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="resolutions.json"',
        },
      })
    }
    if (request.method !== 'POST') return undefined
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    // For this request only: an encrypted bundle's passphrase is never stored.
    const passphrase =
      typeof body.passphrase === 'string' && body.passphrase !== '' ? body.passphrase : undefined

    if (verb === 'answer') {
      const problems = answerProblems(body)
      if (problems.length > 0)
        return Response.json({ ok: false, message: problems[0] }, { status: 400 })
      await repo.answer(bundleId, {
        nodeKey: body.nodeKey as string,
        handle: body.handle as string,
        resolution: (body.resolution as Resolution | null) ?? null,
        by: ctx.user,
      })
      return Response.json(await recheck(ctx, pending, passphrase))
    }
    if (verb === 'missing-files') {
      await repo.setAllowMissingBlobs(bundleId, body.allow === true)
      return Response.json(
        await recheck(ctx, { ...pending, allowMissingBlobs: body.allow === true }, passphrase),
      )
    }
    if (verb === 'check') return Response.json(await recheck(ctx, pending, passphrase))

    const result = await installBundleContent(ctx.db, ctx.config, {
      bundle: pending.target,
      under: pending.under ?? undefined,
      publish: pending.publish,
      allowMissingBlobs: pending.allowMissingBlobs,
      backupTaken: body.backupTaken === true,
      label: pending.label ?? undefined,
      by: ctx.user,
      passphrase,
    })
    if (result.runId) ctx.onApplied()
    const names = new Map(result.check.plan.map((entry) => [entry.key, entry.name] as const))
    return Response.json(
      {
        ok: Boolean(result.runId),
        runId: result.runId ?? null,
        counts: result.check.counts,
        published: result.published,
        publishFailures: result.publishFailures.map((failure) => ({
          name: names.get(failure.key) ?? failure.key,
          reason: failure.reason,
        })),
        outstanding: result.check.outstanding.length,
        problems: result.problems,
      },
      { status: result.runId ? 200 : 409 },
    )
  } catch (error) {
    if (error instanceof PassphraseError)
      return Response.json(
        { ok: false, needsPassphrase: true, message: error.message },
        { status: 409 },
      )
    if (error instanceof CommandError) return unreadable(error)
    if (error instanceof BackupRequiredError)
      return Response.json(
        {
          ok: false,
          needsBackup: true,
          message:
            'This site takes no backup by itself before an import. Take one, then confirm it to go ahead.',
        },
        { status: 409 },
      )
    throw error
  }
}
