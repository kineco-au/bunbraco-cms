/**
 * Approval before publishing (story 028): which workflow covers a page, the
 * gate that refuses publishing a covered page directly, and the requests that
 * go through a workflow's stages. docs/workflows.md.
 *
 * The graph rules are `@crombolo/core`'s; the record is `ApprovalRepository`'s.
 * This decides: who may act, what an edit does to a waiting request, when a
 * stage is done, and when the page is published.
 */
import type { Principal } from '@crombolo/api-management'
import {
  approvalsNeeded,
  DocumentPermissions,
  descendantStages,
  normaliseUuid,
  permissionsForPath,
  type SchemaWorkflow,
  SEND_BACK_TO_EDITOR,
  stagesNowWaiting,
  startStages,
  workflowComplete,
  workflowFor,
} from '@crombolo/core'
import {
  type ApprovalAction,
  ApprovalRepository,
  type ApprovalRepository as ApprovalRepositoryType,
  type ApprovalRequest,
  type ApprovalStep,
  AuditLog,
  type Db,
  DocumentRepository,
  NodeRepository,
  type NodeSchemaState,
  readWorkflows,
  type StoredWorkflow,
  UserGroupRepository,
} from '@crombolo/data'
import type { EmailPort } from './email.ts'

/** What publishing and unpublishing go through when approval says yes. */
export interface ApprovalPublisher {
  publish(
    key: string,
    cultures: string[] | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  unpublish(
    key: string,
    cultures: string[] | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
}

export interface ApprovalsOptions {
  db: Db
  publisher: ApprovalPublisher
  nodeState?: NodeSchemaState
  email?: EmailPort
  /** Where a link in an e-mail points, e.g. `https://site.example/crombolo`. */
  backOfficeUrl?: string
}

/** A refusal a person reads: why, and what to do instead. */
export class ApprovalRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** The page a request or a check is about, as the engine needs it. */
interface PageFacts {
  key: string
  name: string
  chain: string[]
  contentTypeAlias: string | undefined
}

export interface PageApproval {
  /** The workflow that covers the page, as it stands now. */
  workflow: SchemaWorkflow | undefined
  request: RequestView | undefined
  /** Earlier requests, newest first. */
  past: RequestView[]
  can: { send: boolean; requestUnpublish: boolean; publishDirectly: boolean }
}

export interface RequestView {
  key: string
  nodeKey: string
  nodeName: string
  action: ApprovalAction
  cultures: string[] | null
  state: ApprovalRequest['state']
  requestedBy: string
  requestedAt: string
  workflow: SchemaWorkflow
  stages: Array<{
    alias: string
    state: 'waiting' | 'approved' | 'pending' | 'discarded'
    approvals: number
    needed: number
  }>
  history: Array<{
    kind: string
    stage: string | null
    userKey: string | null
    comment: string | null
    at: string
  }>
  /** What the asking user may do now. */
  can: { approve: string[]; sendBack: string[]; withdraw: boolean }
}

export interface Approvals {
  /** The workflows the site has, as last synced. */
  workflows(): Promise<StoredWorkflow[]>
  /** Undefined when the caller may go ahead; otherwise why not. */
  publishRefusal(
    principal: Principal,
    key: string,
    action: ApprovalAction,
  ): Promise<string | undefined>
  /** A branch publish: the root and every page below it. */
  branchRefusal(principal: Principal, key: string): Promise<string | undefined>
  /** For a page being created and published at once: by its parent and type. */
  newPageRefusal(
    principal: Principal,
    parentKey: string | null,
    contentTypeKey: string,
  ): Promise<string | undefined>
  /** Undefined when the save may go ahead; otherwise why not. */
  beforeSave(principal: Principal, key: string): Promise<string | undefined>
  /** What the save does to a waiting request, once it has gone through. */
  afterSave(principal: Principal, key: string): Promise<void>
  send(
    principal: Principal,
    key: string,
    action: ApprovalAction,
    cultures: string[] | null,
    comment?: string,
  ): Promise<RequestView>
  approve(
    principal: Principal,
    requestKey: string,
    stage?: string,
    comment?: string,
  ): Promise<RequestView>
  sendBack(
    principal: Principal,
    requestKey: string,
    stage: string | undefined,
    comment?: string,
  ): Promise<RequestView>
  withdraw(principal: Principal, requestKey: string): Promise<RequestView>
  forPage(principal: Principal, key: string): Promise<PageApproval>
  /** Requests waiting on a stage the user may approve. */
  waitingFor(principal: Principal): Promise<RequestView[]>
  inFlight(principal: Principal): Promise<RequestView[]>
  finished(
    principal: Principal,
    skip: number,
    take: number,
  ): Promise<{ total: number; items: RequestView[] }>
}

export function createApprovals(options: ApprovalsOptions): Approvals {
  const { db } = options
  const requests = (tx: Db = db): ApprovalRepositoryType => new ApprovalRepository(tx)
  const nodes = new NodeRepository(db)
  const groups = new UserGroupRepository(db)
  const audit = new AuditLog(db)

  const page = async (key: string): Promise<PageFacts | undefined> => {
    const node = await nodes.byKey(key)
    if (!node) return undefined
    const ids = node.path
      .split(',')
      .map(Number)
      .filter((id) => id > 0)
    const rows = await nodes.byIds(ids)
    const keyOf = new Map(rows.map((r) => [r.id, r.key]))
    const type = await db.query<{ alias: string }>(
      `SELECT ct.alias FROM content c JOIN content_type ct ON ct.node_id = c.content_type_id WHERE c.node_id = ?`,
      [node.id],
    )
    return {
      key: node.key,
      name: node.text ?? node.key,
      chain: ids.flatMap((id) => keyOf.get(id) ?? []),
      contentTypeAlias: type[0]?.alias,
    }
  }

  const covering = async (facts: PageFacts): Promise<SchemaWorkflow | undefined> =>
    workflowFor(
      (await readWorkflows(db)).map((s) => s.workflow),
      facts.chain,
      facts.contentTypeAlias,
    )

  const groupAliases = async (principal: Principal): Promise<Set<string>> =>
    new Set((await groups.byKeys(principal.groupKeys)).map((g) => g.alias))

  const mayPublish = (principal: Principal, facts: PageFacts, action: ApprovalAction): boolean =>
    principal.isAdmin ||
    permissionsForPath(principal.groups, facts.chain).has(
      action === 'publish' ? DocumentPermissions.Publish : DocumentPermissions.Unpublish,
    )

  const covers = (workflow: SchemaWorkflow | undefined, action: ApprovalAction) =>
    workflow !== undefined && (action === 'publish' || workflow.unpublish)

  const refusalFor = (
    principal: Principal,
    facts: PageFacts,
    workflow: SchemaWorkflow | undefined,
    action: ApprovalAction,
  ): string | undefined => {
    if (!workflow || !covers(workflow, action)) return undefined
    if (workflow.publishersMaySkip && mayPublish(principal, facts, action)) return undefined
    return action === 'publish'
      ? `"${facts.name}" needs approval through "${workflow.name}" before it is published. Send it for approval from its Workflow tab.`
      : `Taking "${facts.name}" down needs approval through "${workflow.name}". Request it from its Workflow tab.`
  }

  const membersOf = async (aliases: readonly string[]): Promise<number> => {
    if (aliases.length === 0) return 0
    const rows = await db.query<{ n: number }>(
      `SELECT COUNT(DISTINCT m.user_id) AS n FROM user_group_member m
       JOIN user_group g ON g.id = m.user_group_id WHERE g.alias IN (${aliases.map(() => '?').join(', ')})`,
      [...aliases],
    )
    return Number(rows[0]?.n ?? 0)
  }

  const stageOf = (workflow: SchemaWorkflow, alias: string) =>
    workflow.stages.find((s) => s.alias === alias)

  /** Approvals given in a stage visit, by distinct user. */
  const approvalsIn = async (
    repo: ApprovalRepositoryType,
    request: ApprovalRequest,
    step: ApprovalStep,
  ) => {
    const history = await repo.history(request.id)
    return new Set(
      history
        .filter((h) => h.kind === 'approved' && h.stepId === step.id && h.userKey)
        .map((h) => h.userKey as string),
    )
  }

  const notify = async (
    to: 'approvers' | 'editor',
    request: ApprovalRequest,
    stages: readonly string[],
    subject: string,
    body: string,
  ) => {
    if (!options.email) return
    let emails: string[] = []
    if (to === 'editor') {
      const rows = await db.query<{ email: string }>(
        'SELECT email FROM user_account WHERE key = ?',
        [request.requestedBy],
      )
      emails = rows.map((r) => r.email)
    } else {
      const aliases = stages.flatMap((s) => stageOf(request.workflow, s)?.approvers ?? [])
      if (aliases.length === 0) return
      const rows = await db.query<{ email: string }>(
        `SELECT DISTINCT u.email FROM user_account u
         JOIN user_group_member m ON m.user_id = u.id JOIN user_group g ON g.id = m.user_group_id
         WHERE g.alias IN (${aliases.map(() => '?').join(', ')}) AND u.is_approved = ?`,
        [...aliases, db.dialect.boolValue(true)],
      )
      emails = rows.map((r) => r.email)
    }
    if (emails.length === 0) return
    const link = options.backOfficeUrl
      ? `\n\n${options.backOfficeUrl}/section/content/workspace/document/edit/${request.nodeKey}`
      : ''
    await options.email.send({
      to: emails.map((email) => ({ email })),
      subject,
      text: `${body}${link}`,
    })
  }

  const auditStep = async (
    principal: Principal | undefined,
    facts: PageFacts | undefined,
    action: string,
    detail: string,
  ) => {
    await audit.record({
      category: 'content',
      action,
      source: 'request',
      userKey: principal?.id ?? null,
      userName: principal?.name ?? null,
      entityType: 'Document',
      entityKey: facts?.key ?? null,
      entityName: facts?.name ?? null,
      detail,
    })
  }

  /**
   * Stages just reached count the person who made the change as approving
   * when the workflow says so and they are in the stage's groups.
   */
  const reach = async (
    repo: ApprovalRepositoryType,
    request: ApprovalRequest,
    stages: readonly string[],
  ): Promise<void> => {
    for (const stage of stages) {
      const stepId = await repo.addStep(request.id, stage)
      if (request.workflow.selfApproval !== 'automatic') continue
      const approvers = stageOf(request.workflow, stage)?.approvers ?? []
      const member = await db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM user_group_member m JOIN user_group g ON g.id = m.user_group_id
         JOIN user_account u ON u.id = m.user_id WHERE u.key = ? AND g.alias IN (${approvers.map(() => '?').join(', ') || "''"})`,
        [request.requestedBy, ...approvers],
      )
      if (Number(member[0]?.n ?? 0) > 0)
        await repo.record(request.id, {
          kind: 'approved',
          stepId,
          stage,
          userKey: request.requestedBy,
          comment: 'counted automatically: they made the change',
        })
    }
  }

  /** Marks done whatever stages have their approvals, reaches what follows, and publishes at the end. */
  /** True when every last stage has approved: the caller publishes, once its transaction is over. */
  const settle = async (
    repo: ApprovalRepositoryType,
    request: ApprovalRequest,
  ): Promise<boolean> => {
    for (let round = 0; round < request.workflow.stages.length + 1; round++) {
      const steps = await repo.steps(request.id)
      let moved = false
      for (const step of steps.filter((s) => s.state === 'waiting')) {
        const stage = stageOf(request.workflow, step.stage)
        if (!stage) continue
        const given = await approvalsIn(repo, request, step)
        if (given.size >= approvalsNeeded(stage.required, await membersOf(stage.approvers))) {
          await repo.setStepState(step.id, 'approved')
          moved = true
        }
      }
      const now = await repo.steps(request.id)
      const approved = new Set(now.filter((s) => s.state === 'approved').map((s) => s.stage))
      const reached = new Set(
        now.filter((s) => s.state === 'waiting' || s.state === 'approved').map((s) => s.stage),
      )
      if (workflowComplete(request.workflow, approved)) return true
      const next = stagesNowWaiting(request.workflow, approved, reached)
      if (next.length > 0) {
        await reach(repo, request, next)
        const facts = await page(request.nodeKey)
        await notify(
          'approvers',
          request,
          next,
          `Waiting for your approval: ${facts?.name ?? 'a page'}`,
          `"${facts?.name}" is waiting for approval through "${request.workflow.name}".`,
        )
        moved = true
      }
      if (!moved) return false
    }
    return false
  }

  /**
   * Publishes (or takes down) a fully approved page, outside any transaction:
   * publishing takes the content tree's lock, which must never be waited on
   * from inside one. A page that cannot be published goes back to its editor
   * with the reason, rather than sitting approved and unpublished.
   */
  const finish = async (
    request: ApprovalRequest,
    principal: Principal | undefined,
  ): Promise<void> => {
    const repo = requests()
    const facts = await page(request.nodeKey)
    const result =
      request.action === 'publish'
        ? await options.publisher.publish(request.nodeKey, request.cultures)
        : await options.publisher.unpublish(request.nodeKey, request.cultures)
    if (!result.ok) {
      await repo.setState(request.id, 'sent-back')
      await repo.record(request.id, {
        kind: 'sent-back',
        comment: `approved, but it could not be ${request.action === 'publish' ? 'published' : 'taken down'}: ${result.reason}`,
      })
      await notify(
        'editor',
        request,
        [],
        `Could not publish: ${facts?.name ?? 'a page'}`,
        `"${facts?.name}" was approved but could not be published: ${result.reason}`,
      )
      return
    }
    await repo.setState(request.id, 'approved')
    await repo.record(request.id, {
      kind: request.action === 'publish' ? 'published' : 'unpublished',
      userKey: principal?.id ?? null,
    })
    await auditStep(
      principal,
      facts,
      request.action === 'publish' ? 'Published on approval' : 'Unpublished on approval',
      `through "${request.workflow.name}"`,
    )
    await notify(
      'editor',
      request,
      [],
      `Approved: ${facts?.name ?? 'a page'}`,
      `"${facts?.name}" was approved through "${request.workflow.name}" and is now ${request.action === 'publish' ? 'published' : 'taken down'}.`,
    )
  }

  const view = async (principal: Principal, request: ApprovalRequest): Promise<RequestView> => {
    const repo = requests()
    const steps = await repo.steps(request.id)
    const history = await repo.history(request.id)
    const mine = await groupAliases(principal)
    const facts = await page(request.nodeKey)
    const current = new Map<string, ApprovalStep>()
    for (const step of steps)
      if (step.state === 'waiting' || step.state === 'approved') current.set(step.stage, step)
    const stages: RequestView['stages'] = []
    for (const stage of request.workflow.stages) {
      const step = current.get(stage.alias)
      const given = step
        ? history.filter((h) => h.kind === 'approved' && h.stepId === step.id).length
        : 0
      stages.push({
        alias: stage.alias,
        state: step
          ? (step.state as 'waiting' | 'approved')
          : steps.some((s) => s.stage === stage.alias)
            ? 'discarded'
            : 'pending',
        approvals: given,
        needed: approvalsNeeded(stage.required, await membersOf(stage.approvers)),
      })
    }
    const waiting = request.state === 'waiting'
    const actionable = waiting
      ? request.workflow.stages.filter(
          (s) => current.get(s.alias)?.state === 'waiting' && s.approvers.some((a) => mine.has(a)),
        )
      : []
    const already = (alias: string) =>
      history.some(
        (h) =>
          h.kind === 'approved' &&
          h.stepId === current.get(alias)?.id &&
          h.userKey === normaliseUuid(principal.id),
      )
    const ownChange = normaliseUuid(principal.id) === request.requestedBy
    return {
      key: request.key,
      nodeKey: request.nodeKey,
      nodeName: facts?.name ?? request.nodeKey,
      action: request.action,
      cultures: request.cultures,
      state: request.state,
      requestedBy: request.requestedBy,
      requestedAt: request.requestedAt.toISOString(),
      workflow: request.workflow,
      stages,
      history: history.map((h) => ({
        kind: h.kind,
        stage: h.stage,
        userKey: h.userKey,
        comment: h.comment,
        at: h.createDate.toISOString(),
      })),
      can: {
        approve:
          ownChange && request.workflow.selfApproval === 'refused'
            ? []
            : actionable.filter((s) => !already(s.alias)).map((s) => s.alias),
        sendBack: actionable.map((s) => s.alias),
        withdraw: waiting && (ownChange || principal.isAdmin),
      },
    }
  }

  /** After a decision's transaction: publishes when it completed the workflow, then the request as it stands. */
  const concluded = async (
    principal: Principal,
    outcome: { request: ApprovalRequest; complete: boolean },
  ): Promise<RequestView> => {
    if (outcome.complete) await finish(outcome.request, principal)
    return view(principal, (await requests().byKey(outcome.request.key)) as ApprovalRequest)
  }

  const needsComment = (
    workflow: SchemaWorkflow,
    decision: 'approve' | 'send-back',
    comment: string | undefined,
  ) =>
    (workflow.comments === 'always' ||
      (workflow.comments === 'on-send-back' && decision === 'send-back')) &&
    !comment?.trim()

  const waitingRequest = async (requestKey: string): Promise<ApprovalRequest> => {
    const request = await requests().byKey(requestKey)
    if (!request) throw new ApprovalRefused('There is no such request.', 404)
    if (request.state !== 'waiting')
      throw new ApprovalRefused('This request has already been decided.', 409)
    return request
  }

  return {
    workflows: () => readWorkflows(db),

    async publishRefusal(principal, key, action) {
      const facts = await page(key)
      if (!facts) return undefined
      return refusalFor(principal, facts, await covering(facts), action)
    },

    async branchRefusal(principal, key) {
      const root = await nodes.byKey(key)
      if (!root) return undefined
      const workflows = (await readWorkflows(db)).map((s) => s.workflow)
      if (workflows.length === 0) return undefined
      const below = await db.query<{ unique_id: string }>(
        'SELECT unique_id FROM node WHERE id = ? OR path LIKE ? ORDER BY level',
        [root.id, `${root.path},%`],
      )
      for (const row of below) {
        const facts = await page(String(row.unique_id))
        if (!facts) continue
        const refusal = refusalFor(principal, facts, await covering(facts), 'publish')
        if (refusal) return refusal
      }
      return undefined
    },

    async newPageRefusal(principal, parentKey, contentTypeKey) {
      const parent = parentKey ? await page(parentKey) : undefined
      const type = await db.query<{ alias: string }>(
        'SELECT ct.alias FROM content_type ct JOIN node n ON n.id = ct.node_id WHERE n.unique_id = ?',
        [normaliseUuid(contentTypeKey)],
      )
      const facts: PageFacts = {
        key: '',
        name: 'This page',
        chain: parent?.chain ?? [],
        contentTypeAlias: type[0]?.alias,
      }
      return refusalFor(principal, facts, await covering(facts), 'publish')
    },

    async beforeSave(principal, key) {
      const request = await requests().waitingFor(key)
      if (!request || principal.isAdmin) return undefined
      const edit = request.workflow.onEdit
      if (edit === 'lock')
        return 'This page is waiting for approval and cannot be changed until it is decided.'
      if (edit === 'lock-after-first-approval') {
        const history = await requests().history(request.id)
        if (history.some((h) => h.kind === 'approved'))
          return 'This page has been approved by someone already, and cannot be changed until the request is decided.'
      }
      return undefined
    },

    async afterSave(principal, key) {
      const repo = requests()
      const request = await repo.waitingFor(key)
      if (!request) return
      const head =
        (await new DocumentRepository(db, { nodeState: options.nodeState }).eventMarkers(key))
          ?.head ?? null
      if (head === request.eventId) return
      // Administrators may always edit; the request goes on, on what they saved.
      if (!principal.isAdmin && request.workflow.onEdit === 'withdraw') {
        await repo.setState(request.id, 'withdrawn')
        await repo.record(request.id, {
          kind: 'withdrawn',
          userKey: principal.id,
          comment: 'the page was changed after it was sent',
        })
        return
      }
      await repo.setEvent(request.id, head)
      await repo.record(request.id, { kind: 'edited', userKey: principal.id })
    },

    async send(principal, key, action, cultures, comment) {
      const facts = await page(key)
      if (!facts) throw new ApprovalRefused('The page could not be found.', 404)
      const workflow = await covering(facts)
      if (!workflow || !covers(workflow, action))
        throw new ApprovalRefused(
          action === 'publish'
            ? 'No workflow covers this page: it can be published directly.'
            : 'Taking this page down needs no approval.',
        )
      const stored = (await readWorkflows(db)).find(
        (s) => (s.workflow.key ?? s.workflow.alias) === (workflow.key ?? workflow.alias),
      )
      const outcome = await db.transaction(async (tx) => {
        const repo = requests(tx)
        if (await repo.waitingFor(key))
          throw new ApprovalRefused('This page is already waiting for approval.', 409)
        const head =
          (await new DocumentRepository(tx, { nodeState: options.nodeState }).eventMarkers(key))
            ?.head ?? null
        const request = await repo.create({
          nodeKey: key,
          cultures,
          action,
          eventId: head,
          workflow,
          workflowVersion: stored?.version ?? '',
          requestedBy: principal.id,
        })
        await repo.record(request.id, {
          kind: 'sent',
          userKey: principal.id,
          comment: comment?.trim() || null,
        })
        const first = startStages(workflow)
        await reach(repo, request, first)
        await notify(
          'approvers',
          request,
          first,
          `Waiting for your approval: ${facts.name}`,
          `${principal.name} sent "${facts.name}" for approval through "${workflow.name}".${comment ? `\n\n${comment}` : ''}`,
        )
        const complete = await settle(repo, request)
        await auditStep(
          principal,
          facts,
          action === 'publish' ? 'Sent for approval' : 'Requested unpublish',
          `through "${workflow.name}"`,
        )
        return { request, complete }
      })
      return concluded(principal, outcome)
    },

    async approve(principal, requestKey, stage, comment) {
      const request = await waitingRequest(requestKey)
      const current = await view(principal, request)
      const target = stage ?? current.can.approve[0]
      if (!target || !current.can.approve.includes(target))
        throw new ApprovalRefused(
          normaliseUuid(principal.id) === request.requestedBy &&
            request.workflow.selfApproval === 'refused'
            ? 'You made this change, so someone else has to approve it.'
            : 'There is no stage waiting for your approval on this request.',
          403,
        )
      if (needsComment(request.workflow, 'approve', comment))
        throw new ApprovalRefused('This workflow asks for a comment with every decision.')
      const outcome = await db.transaction(async (tx) => {
        const repo = requests(tx)
        const step = (await repo.steps(request.id)).find(
          (s) => s.stage === target && s.state === 'waiting',
        )
        await repo.record(request.id, {
          kind: 'approved',
          stepId: step?.id ?? null,
          stage: target,
          userKey: principal.id,
          comment: comment?.trim() || null,
        })
        const complete = await settle(repo, request)
        await auditStep(
          principal,
          await page(request.nodeKey),
          'Approved',
          `stage "${target}" of "${request.workflow.name}"`,
        )
        return { request, complete }
      })
      return concluded(principal, outcome)
    },

    async sendBack(principal, requestKey, stage, comment) {
      const request = await waitingRequest(requestKey)
      const current = await view(principal, request)
      const from = stage ?? current.can.sendBack[0]
      if (!from || !current.can.sendBack.includes(from))
        throw new ApprovalRefused(
          'There is no stage waiting for your decision on this request.',
          403,
        )
      if (needsComment(request.workflow, 'send-back', comment))
        throw new ApprovalRefused('Say why it is being sent back.')
      const to = stageOf(request.workflow, from)?.sendBack ?? SEND_BACK_TO_EDITOR
      const outcome = await db.transaction(async (tx) => {
        const repo = requests(tx)
        let complete = false
        const steps = await repo.steps(request.id)
        await repo.record(request.id, {
          kind: 'sent-back',
          stage: from,
          userKey: principal.id,
          comment: comment?.trim() || null,
        })
        const facts = await page(request.nodeKey)
        if (to === SEND_BACK_TO_EDITOR) {
          for (const step of steps.filter((s) => s.state === 'waiting' || s.state === 'approved'))
            await repo.setStepState(step.id, step.stage === from ? 'sent-back' : 'discarded')
          await repo.setState(request.id, 'sent-back')
          await notify(
            'editor',
            request,
            [],
            `Sent back: ${facts?.name ?? 'a page'}`,
            `"${facts?.name}" was sent back${comment ? `:\n\n${comment}` : '.'}`,
          )
        } else {
          // The stage it goes back to runs again, and so does everything after it.
          const redo = new Set([to, ...descendantStages(request.workflow, to)])
          for (const step of steps.filter(
            (s) => (s.state === 'waiting' || s.state === 'approved') && redo.has(s.stage),
          ))
            await repo.setStepState(step.id, step.stage === from ? 'sent-back' : 'discarded')
          await reach(repo, request, [to])
          await notify(
            'approvers',
            request,
            [to],
            `Back for your approval: ${facts?.name ?? 'a page'}`,
            `"${facts?.name}" was sent back to you${comment ? `:\n\n${comment}` : '.'}`,
          )
          complete = await settle(repo, request)
        }
        await auditStep(
          principal,
          facts,
          'Sent back',
          `from stage "${from}" of "${request.workflow.name}" to ${to === SEND_BACK_TO_EDITOR ? 'the editor' : `"${to}"`}`,
        )
        return { request, complete }
      })
      return concluded(principal, outcome)
    },

    async withdraw(principal, requestKey) {
      const request = await waitingRequest(requestKey)
      if (normaliseUuid(principal.id) !== request.requestedBy && !principal.isAdmin)
        throw new ApprovalRefused(
          'Only the person who sent it, or an administrator, can withdraw it.',
          403,
        )
      await requests().setState(request.id, 'withdrawn')
      await requests().record(request.id, { kind: 'withdrawn', userKey: principal.id })
      await auditStep(
        principal,
        await page(request.nodeKey),
        'Withdrew approval request',
        `under "${request.workflow.name}"`,
      )
      return view(principal, (await requests().byKey(request.key)) as ApprovalRequest)
    },

    async forPage(principal, key) {
      const facts = await page(key)
      if (!facts) throw new ApprovalRefused('The page could not be found.', 404)
      const workflow = await covering(facts)
      const all = await requests().forNode(key)
      const waiting = all.find((r) => r.state === 'waiting')
      return {
        workflow,
        request: waiting ? await view(principal, waiting) : undefined,
        past: await Promise.all(
          all
            .filter((r) => r !== waiting)
            .slice(0, 10)
            .map((r) => view(principal, r)),
        ),
        can: {
          send: !waiting && covers(workflow, 'publish'),
          requestUnpublish: !waiting && covers(workflow, 'unpublish'),
          publishDirectly: refusalFor(principal, facts, workflow, 'publish') === undefined,
        },
      }
    },

    async waitingFor(principal) {
      const out: RequestView[] = []
      for (const request of await requests().waiting()) {
        const v = await view(principal, request)
        if (v.can.approve.length > 0 || v.can.sendBack.length > 0) out.push(v)
      }
      return out
    },

    async inFlight(principal) {
      return Promise.all((await requests().waiting()).map((r) => view(principal, r)))
    },

    async finished(principal, skip, take) {
      const page = await requests().finished(skip, take)
      return {
        total: page.total,
        items: await Promise.all(page.items.map((r) => view(principal, r))),
      }
    },
  }
}
