/**
 * The Workflows section's and the page tab's reads and actions (story 028),
 * under `<backoffice>/crombolo/api/approvals/`, and saving a workflow drawn in
 * the designer back to `schema/workflows/`. docs/workflows.md.
 *
 * A workflow is written as its file, validated against the whole set first,
 * then synced at once, so the gate follows it without a restart; the file is
 * the truth, as for forms, and a read-only schema directory refuses the save.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Principal } from '@crombolo/api-management'
import type { SchemaWorkflow } from '@crombolo/core'
import { type Db, readWorkflows, syncWorkflows, UserGroupRepository } from '@crombolo/data'
import {
  fileNameFor,
  loadSchemaDirectory,
  parseWorkflow,
  validateWorkflows,
  workflowVersion,
  writeWorkflow,
} from '@crombolo/schema'
import { ApprovalRefused, type Approvals } from './approvals.ts'

export interface ApprovalsApiContext {
  db: Db
  approvals: Approvals
  principal: Principal
  schemaDir: string
  /** False on a deployed node with no schema store: a save would not last. */
  writable: boolean
  onChanged?: () => Promise<void>
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** The workflows in `schema/workflows/`, synced into the database: what the gate reads. */
export async function syncWorkflowFiles(db: Db, schemaDir: string) {
  const workflows = loadSchemaDirectory(schemaDir).set.workflows ?? []
  return syncWorkflows(
    db,
    workflows.map((workflow) => ({ workflow, version: workflowVersion(workflow) })),
  )
}

/** What saving a workflow would do to the requests in flight under it. */
async function changePreview(approvals: Approvals, principal: Principal, workflow: SchemaWorkflow) {
  const id = workflow.key ?? workflow.alias
  const stored = (await approvals.workflows()).find(
    (s) => (s.workflow.key ?? s.workflow.alias) === id,
  )
  const version = workflowVersion(workflow)
  if (stored && stored.version === version) return []
  const waiting = (await approvals.inFlight(principal)).filter(
    (r) => (r.workflow.key ?? r.workflow.alias) === id,
  )
  return waiting.map((r) => ({ key: r.key, page: r.nodeName, outcome: workflow.onChange }))
}

export async function handleApprovalsApi(
  request: Request,
  path: string,
  ctx: ApprovalsApiContext,
): Promise<Response | undefined> {
  const { approvals, principal } = ctx
  const body = async () => (await request.json().catch(() => ({}))) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  try {
    let match = /^page\/([^/]+)$/.exec(path)
    if (match && request.method === 'GET')
      return json(await approvals.forPage(principal, decodeURIComponent(match[1] as string)))

    match = /^page\/([^/]+)\/send$/.exec(path)
    if (match && request.method === 'POST') {
      const b = await body()
      const cultures = Array.isArray(b.cultures) ? b.cultures.map(String) : null
      return json(
        await approvals.send(
          principal,
          decodeURIComponent(match[1] as string),
          b.action === 'unpublish' ? 'unpublish' : 'publish',
          cultures && cultures.length > 0 ? cultures : null,
          text(b.comment),
        ),
      )
    }

    match = /^request\/([^/]+)\/(approve|send-back|withdraw)$/.exec(path)
    if (match && request.method === 'POST') {
      const key = decodeURIComponent(match[1] as string)
      const b = await body()
      if (match[2] === 'approve')
        return json(await approvals.approve(principal, key, text(b.stage), text(b.comment)))
      if (match[2] === 'send-back')
        return json(await approvals.sendBack(principal, key, text(b.stage), text(b.comment)))
      return json(await approvals.withdraw(principal, key))
    }

    if (path === 'waiting' && request.method === 'GET')
      return json({ items: await approvals.waitingFor(principal) })
    if (path === 'in-flight' && request.method === 'GET')
      return json({ items: await approvals.inFlight(principal) })
    if (path === 'history' && request.method === 'GET') {
      const url = new URL(request.url)
      const skip = Math.max(0, Number(url.searchParams.get('skip') ?? 0) || 0)
      const take = Math.min(100, Math.max(1, Number(url.searchParams.get('take') ?? 25) || 25))
      return json(await approvals.finished(principal, skip, take))
    }

    if (path === 'workflows' && request.method === 'GET') {
      const loaded = loadSchemaDirectory(ctx.schemaDir)
      return json({
        items: (await readWorkflows(ctx.db)).map((s) => s.workflow),
        editable: ctx.writable && principal.isAdmin,
        groups: (await new UserGroupRepository(ctx.db).all()).map((g) => ({
          alias: g.alias,
          name: g.name,
        })),
        contentTypes: loaded.set.contentTypes.map((t) => ({ alias: t.alias, name: t.name })),
      })
    }

    match = /^workflows\/([^/]+)(\/preview)?$/.exec(path)
    if (match) {
      if (!principal.isAdmin)
        return json({ ok: false, message: 'Only administrators change workflows.' }, 403)
      const alias = decodeURIComponent(match[1] as string)
      const file = join(ctx.schemaDir, 'workflows', fileNameFor(alias))
      if (request.method === 'DELETE') {
        if (!ctx.writable) return readOnly()
        if (!existsSync(file))
          return json({ ok: false, message: 'There is no such workflow.' }, 404)
        rmSync(file)
        await ctx.onChanged?.()
        return json({ ok: true, report: await syncWorkflowFiles(ctx.db, ctx.schemaDir) })
      }
      if (request.method !== 'PUT' && request.method !== 'POST') return undefined
      const b = await body()
      // Through the file and the strict parser, as a hand-written one would be.
      const source = writeWorkflow(b.workflow as SchemaWorkflow)
      const parsed = parseWorkflow(`schema/workflows/${fileNameFor(alias)}`, source)
      if (!parsed.value) return json({ ok: false, problems: parsed.problems }, 400)
      const workflow = parsed.value
      const loaded = loadSchemaDirectory(ctx.schemaDir)
      const others = (loaded.set.workflows ?? []).filter(
        (w) => w.alias !== alias && w.alias !== workflow.alias,
      )
      const problems = validateWorkflows(
        [...others, workflow],
        new Set(loaded.set.contentTypes.map((t) => t.alias)),
      )
      const groups = new Set((await new UserGroupRepository(ctx.db).all()).map((g) => g.alias))
      workflow.stages.forEach((stage, i) => {
        for (const approver of stage.approvers)
          if (!groups.has(approver))
            problems.push({
              file: `schema/workflows/${fileNameFor(workflow.alias)}`,
              path: `stage[${i}].approvers`,
              message: `there is no user group "${approver}"`,
            })
      })
      if (problems.length > 0) return json({ ok: false, problems }, 400)
      const affected = await changePreview(approvals, principal, workflow)
      if (match[2]) return json({ ok: true, affected })
      if (!ctx.writable) return readOnly()
      mkdirSync(join(ctx.schemaDir, 'workflows'), { recursive: true })
      // A renamed workflow leaves its old file behind otherwise.
      if (alias !== workflow.alias && existsSync(file)) rmSync(file)
      writeFileSync(join(ctx.schemaDir, 'workflows', fileNameFor(workflow.alias)), source, 'utf8')
      await ctx.onChanged?.()
      return json({ ok: true, affected, report: await syncWorkflowFiles(ctx.db, ctx.schemaDir) })
    }
  } catch (error) {
    if (error instanceof ApprovalRefused)
      return json({ ok: false, message: error.message }, error.status)
    throw error
  }
  return undefined
}

const readOnly = () =>
  json(
    {
      ok: false,
      message:
        'The schema directory is read-only on this server, so a workflow cannot be saved here. Change the file in the repository and deploy it.',
    },
    409,
  )
