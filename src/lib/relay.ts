import { beadText, execStdout, mapLimit } from './exec'
import { runList, runListAsync, showBeadAsync } from '../routes/query/store'
import { cleanLabel, type Row } from '../routes/query/params'
import { createBead } from './create'
import { editBead } from './edit'
import { commentBead, labelBead, noteBead } from './mutate'
import { requireVerified } from './receipts'
import { storeFromId } from '../util'
import { STORES } from '../config'

export type ProjectState = 'foreground' | 'backlog'
export type CaptureKind = 'observation' | 'idea' | 'friction' | 'correction' | 'knowledge'

export interface ProjectCandidate {
  id: string
  slug: string
  title: string
  state: ProjectState
  backlog: boolean
  score: number
  via: string
  description?: string
}

export interface RankRow {
  id: string
  title: string
  labels: string[]
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function tokens(s: string): string[] {
  return [...new Set(normalize(s).split(' ').filter((t) => t.length > 1))]
}

export function slugify(s: string): string {
  return normalize(s).split(' ').filter(Boolean).join('-').slice(0, 64) || 'untitled'
}

export function slugOf(labels: string[], title: string): string {
  for (const l of labels) {
    if (l.startsWith('project:') && l.length > 8) return l.slice(8)
  }
  return slugify(title)
}

export function projectState(labels: string[]): ProjectState {
  return labels.includes('state:foreground') ? 'foreground' : 'backlog'
}

export type ProjectLifecycle = 'active' | 'deprecated'
export const LIFECYCLE_DEPRECATED = 'state:deprecated'

export function lifecycleState(labels: string[]): ProjectLifecycle {
  return labels.includes(LIFECYCLE_DEPRECATED) ? 'deprecated' : 'active'
}

export function lifecycleLabels(lifecycle: ProjectLifecycle): { add?: string; remove?: string } {
  return lifecycle === 'deprecated' ? { add: LIFECYCLE_DEPRECATED } : { remove: LIFECYCLE_DEPRECATED }
}

export function aliasTexts(labels: string[]): string[] {
  const out: string[] = []
  for (const l of labels) {
    if (l.startsWith('alias:')) out.push(l.slice(6).replace(/[-_]/g, ' '))
    else if (l.startsWith('aka:')) out.push(l.slice(4).replace(/[-_]/g, ' '))
  }
  return out
}

function overlap(a: string[], b: Set<string>): number {
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n
}

export function scoreRow(query: string[], row: RankRow): { score: number; via: string } {
  const qset = new Set(query)
  const slug = slugOf(row.labels, row.title)
  const slugToks = new Set(slug.replace(/-/g, ' ').split(' ').filter(Boolean))
  const titleToks = tokens(row.title)
  const aliases = aliasTexts(row.labels)
  const aliasToks = new Set(aliases.flatMap((a) => tokens(a)))
  const normQ = normalize(query.join(' '))
  const normSlug = slug.replace(/-/g, ' ')
  if (normQ && (normQ === normalize(row.title) || normQ === normSlug)) {
    return { score: 100, via: 'exact' }
  }
  if (normQ && normSlug && (normSlug.includes(normQ) || normQ.includes(normSlug))) {
    return { score: 60 + overlap(query, slugToks) * 4, via: 'slug' }
  }
  const t = overlap(query, new Set(titleToks))
  const a = overlap(query, aliasToks)
  const s = overlap(query, slugToks)
  const score = t * 10 + a * 8 + s * 6
  const via = a > 0 && a >= t ? 'alias' : s > 0 && t === 0 ? 'slug' : 'title'
  return { score, via }
}

export function rankProjects(text: string, rows: RankRow[], limit = 5): ProjectCandidate[] {
  const q = tokens(text)
  if (!q.length) return []
  return rows
    .map((r) => {
      const { score, via } = scoreRow(q, r)
      const state = projectState(r.labels)
      return {
        id: r.id,
        slug: slugOf(r.labels, r.title),
        title: r.title.slice(0, 160),
        state,
        backlog: state === 'backlog',
        score,
        via,
      } as ProjectCandidate
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, Math.max(1, Math.min(10, limit)))
}

export const CAPTURE_STORES: Record<CaptureKind, string> = {
  observation: 'brain',
  idea: 'ideas',
  friction: 'friction',
  correction: 'brain',
  knowledge: 'brain',
}

export function captureStoreFor(kind: string): string | null {
  const k = kind.trim().toLowerCase() as CaptureKind
  return CAPTURE_STORES[k] ?? null
}

export function duplicateScore(a: string, b: string): number {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.85
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.max(ta.size, tb.size)
}

export function findDuplicate(title: string, rows: RankRow[], threshold = 0.6): RankRow | null {
  let best: RankRow | null = null
  let bestScore = 0
  for (const r of rows) {
    const s = duplicateScore(title, r.title)
    if (s > bestScore) {
      bestScore = s
      best = r
    }
  }
  return bestScore >= threshold ? best : null
}

export function dispatchLabels(slug: string | undefined): string[] {
  const out = ['dispatch:requested']
  if (slug) out.push(`project:${slug}`)
  return out.map(cleanLabel).filter((x): x is string => !!x)
}

export interface FlowStep {
  name: string
  ok: boolean
  detail: string
}

export interface FlowResult {
  steps: FlowStep[]
  project?: ProjectCandidate
  taskId?: string
  dispatchId?: string
  promoted?: boolean
  complete: boolean
}

function snippet(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export async function fetchProjectRows(limit = 200): Promise<RankRow[]> {
  const { rows } = runList('projects', [], [], {
    exclude: [],
    status: undefined,
    limit: Math.max(1, Math.min(200, limit)),
    allStates: true,
  })
  return rows
}

export async function resolveProject(text: string, limit = 5): Promise<ProjectCandidate[]> {
  const rows = await fetchProjectRows(200)
  const ranked = rankProjects(text, rows, limit)
  const enriched = await mapLimit(ranked, 4, async (c) => {
    const body = await showBeadAsync('projects', c.id)
    return body ? { ...c, description: snippet(body.replace(/\s+/g, ' ').trim()) } : c
  })
  return enriched
}

export function resolveProjectIdOrSlug(ref: string, rows: RankRow[]): RankRow | null {
  const clean = ref.trim()
  if (!clean) return null
  const byId = rows.find((r) => r.id.toLowerCase() === clean.toLowerCase())
  if (byId) return byId
  const slug = clean.toLowerCase().replace(/^project:/, '')
  const bySlug = rows.find((r) => slugOf(r.labels, r.title).toLowerCase() === slug)
  if (bySlug) return bySlug
  return null
}

export async function lookupProject(ref: string): Promise<{ row: RankRow; state: ProjectState; slug: string } | null> {
  const rows = await fetchProjectRows(200)
  const direct = resolveProjectIdOrSlug(ref, rows)
  if (direct) {
    return { row: direct, state: projectState(direct.labels), slug: slugOf(direct.labels, direct.title) }
  }
  const ranked = rankProjects(ref, rows, 1)
  if (!ranked.length) return null
  const row = rows.find((r) => r.id === ranked[0].id)
  if (!row) return null
  return { row, state: projectState(row.labels), slug: slugOf(row.labels, row.title) }
}

export async function promoteProject(id: string, reason: string): Promise<{ promoted: boolean; detail: string }> {
  try {
    const l = await labelBead('projects', id, { add: 'state:foreground' })
    const c = await commentBead('projects', id, `Promoted to foreground ${new Date().toISOString()} — ${reason.slice(0, 200)}`)
    if (!l.verified || !c.verified) {
      const missing = [!l.verified ? 'label' : null, !c.verified ? 'promotion note' : null].filter((x): x is string => !!x).join(' + ')
      return { promoted: false, detail: `promotion unverified: ${missing} on ${id} (STORE: projects) did not read back — not reporting success` }
    }
    return { promoted: true, detail: `labeled state:foreground + noted promotion on ${id} (verified: true)` }
  } catch (e) {
    return { promoted: false, detail: `promotion failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }
  }
}

export interface ProjectEditInput {
  project: string
  title?: string
  description?: string
  note?: string
  lifecycle?: ProjectLifecycle
}

export interface ProjectEditPlan {
  ref: string
  title?: string
  description?: string
  note?: string
  lifecycle?: ProjectLifecycle
}

// Pure validation: resolves the project reference and rejects malformed
// calls before any store work. Mirrors editBead's field semantics — title
// trims empties away, description passes through (empty clears it).
export function planProjectEdit(input: ProjectEditInput): ProjectEditPlan {
  const ref = input.project.trim()
  if (!ref) throw new Error('project is required (id, slug, or name)')
  const title = input.title?.trim()
  const description = input.description
  const note = input.note?.trim()
  const lifecycle = input.lifecycle
  if (!title && description === undefined && !note && !lifecycle) {
    throw new Error('give title, description, note, and/or lifecycle')
  }
  if (lifecycle && lifecycle !== 'active' && lifecycle !== 'deprecated') {
    throw new Error(`unknown lifecycle: ${lifecycle} (want active|deprecated)`)
  }
  return { ref, title: title || undefined, description, note: note || undefined, lifecycle }
}

export interface ProjectEditResult {
  id: string
  slug: string
  title: string
  state: ProjectState
  lifecycle: ProjectLifecycle
  steps: FlowStep[]
  complete: boolean
}

const isUnverified = (e: unknown): boolean => e instanceof Error && e.message.startsWith('unverified:')

// Direct project-level edit: resolve the project, revise title/description,
// append a note, and/or set lifecycle status. Never creates task or
// correction beads. Every mutation step verifies read-after-write; an
// unverified write rethrows (never a partial success), while a blocked
// write lands as a labeled failed step so partial application is explicit.
export async function editProject(input: ProjectEditInput): Promise<ProjectEditResult> {
  const plan = planProjectEdit(input)
  const found = await lookupProject(plan.ref)
  if (!found) throw new Error(`unknown project: ${plan.ref}`)
  const id = found.row.id
  const slug = found.slug
  const steps: FlowStep[] = []
  const content: string[] = []
  if (plan.title) content.push('title')
  if (plan.description !== undefined) content.push('description')
  if (content.length) {
    try {
      const edited = await editBead({ store: 'projects', id, title: plan.title, description: plan.description })
      requireVerified({ operation: 'updated', id, store: 'projects', verified: edited.verified })
      steps.push({ name: 'update', ok: true, detail: `${content.join(' + ')} updated (verified)` })
    } catch (e) {
      if (isUnverified(e)) throw e
      steps.push({ name: 'update', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  if (plan.note) {
    try {
      const n = await noteBead('projects', id, plan.note)
      requireVerified({ operation: 'note added', id, store: 'projects', verified: n.verified })
      steps.push({ name: 'note', ok: true, detail: 'note appended (verified)' })
    } catch (e) {
      if (isUnverified(e)) throw e
      steps.push({ name: 'note', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  if (plan.lifecycle) {
    try {
      const l = await labelBead('projects', id, lifecycleLabels(plan.lifecycle))
      requireVerified({ operation: 'labels updated', id, store: 'projects', verified: l.verified })
      const action = lifecycleLabels(plan.lifecycle).add ? `${LIFECYCLE_DEPRECATED} added` : `${LIFECYCLE_DEPRECATED} removed`
      steps.push({ name: 'lifecycle', ok: true, detail: `set ${plan.lifecycle} — ${action} (verified)` })
    } catch (e) {
      if (isUnverified(e)) throw e
      steps.push({ name: 'lifecycle', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  const complete = steps.length > 0 && steps.every((s) => s.ok)
  return {
    id,
    slug,
    title: (plan.title ?? found.row.title).slice(0, 160),
    state: projectState(found.row.labels),
    lifecycle: plan.lifecycle ?? lifecycleState(found.row.labels),
    steps,
    complete,
  }
}

export function formatProjectEdit(r: ProjectEditResult): string {
  const lines = r.steps.map((s) => `- ${s.name}: ${s.ok ? 'ok' : 'FAILED'} — ${s.detail}`)
  const lifecycle = r.lifecycle === 'deprecated' ? 'deprecated (state:deprecated)' : 'active'
  return [
    `# project updated ${r.id} (STORE: projects)`,
    ``,
    `project: ${r.slug}`,
    `title: ${r.title}`,
    `state: ${r.state} · lifecycle: ${lifecycle}`,
    ``,
    ...lines,
    ...(r.complete
      ? [``, `All steps verified — project reads back.`]
      : [``, `Partial: ${r.steps.filter((s) => !s.ok).length} step(s) failed — re-read ${r.id} before reporting success.`]),
  ].join('\n')
}

export interface CaptureInput {
  text: string
  kind: string
  project?: string
  store?: string
}

export async function captureEntry(input: CaptureInput): Promise<{ id: string; store: string; slug?: string; promoted: boolean; detail: string }> {
  const text = input.text.trim()
  if (!text) throw new Error('text is required')
  const store = input.store?.trim() || captureStoreFor(input.kind) || null
  if (!store) throw new Error(`unknown kind: ${input.kind} (want observation, idea, friction, correction, knowledge)`)
  if (!STORES.includes(store)) throw new Error(`unknown store: ${store}`)
  let slug: string | undefined
  let wasBacklog = false
  let projectId: string | null = null
  if (input.project?.trim()) {
    const found = await lookupProject(input.project.trim())
    if (!found) throw new Error(`unknown project: ${input.project}`)
    slug = found.slug
    projectId = found.row.id
    wasBacklog = found.state === 'backlog'
  }
  const labels = slug ? [`project:${slug}`] : []
  const title = snippet(text.split('\n')[0].slice(0, 120) || 'captured note', 120)
  const created = await createBead({
    store,
    title,
    description: slug ? `${text.slice(0, 3500)}\n\nproject: ${slug}` : text.slice(0, 3500),
    labels: labels.map(cleanLabel).filter((x): x is string => !!x),
  })
  // False-success guardrail: an unverified create is an error naming the
  // bead, never a captured success.
  requireVerified({ operation: 'created', id: created.id, store, verified: created.verified })
  const { id, detail } = created
  let promoted = false
  if (projectId && wasBacklog) {
    promoted = (await promoteProject(projectId, `capture ${id} in ${store}`)).promoted
  }
  return { id, store, slug, promoted, detail }
}

export interface UpsertInput {
  title: string
  description?: string
  project?: string
  labels?: string[]
  allowUpdate?: boolean
}

export async function upsertTask(input: UpsertInput): Promise<{ mode: 'created' | 'updated'; id: string; duplicateOf?: string; slug?: string; promoted: boolean; detail: string }> {
  const title = input.title.trim().slice(0, 200)
  if (!title) throw new Error('title is required')
  let slug: string | undefined
  let projectId: string | null = null
  let wasBacklog = false
  if (input.project?.trim()) {
    const found = await lookupProject(input.project.trim())
    if (!found) throw new Error(`unknown project: ${input.project}`)
    slug = found.slug
    projectId = found.row.id
    wasBacklog = found.state === 'backlog'
  }
  const labelFilter = slug ? [`project:${slug}`] : []
  const { rows } = runList('task', labelFilter, [], {
    exclude: [],
    title: title.slice(0, 60),
    status: undefined,
    limit: 20,
    allStates: true,
  })
  const scoped = rows.length ? rows : runList('task', [], [], { exclude: [], status: undefined, limit: 50, allStates: true }).rows
  const dup = input.allowUpdate === false ? null : findDuplicate(title, scoped)
  let promoted = false
  const maybePromote = async () => {
    if (projectId && wasBacklog) promoted = (await promoteProject(projectId, `task write for ${slug}`)).promoted
  }
  if (dup) {
    const extra = input.description?.trim()
    if (extra) {
      try {
        const edited = await editBead({ store: 'task', id: dup.id, description: `${extra.slice(0, 3500)}` })
        requireVerified({ operation: 'updated', id: dup.id, store: 'task', verified: edited.verified })
      } catch (e) {
        // editBead throws on write failure AND on unverified writes (both
        // carry a message); fall back to a comment only for write failures.
        // An unverified edit already names the bead — rethrow, never mask it
        // as success via a comment.
        if (e instanceof Error && e.message.startsWith('unverified:')) throw e
        requireVerified(await commentBead('task', dup.id, extra.slice(0, 500)))
      }
    } else {
      requireVerified(await commentBead('task', dup.id, `Touched by relay upsert ${new Date().toISOString()}`))
    }
    await maybePromote()
    // Read-after-write with a null check: beadText degrades failures to
    // text, so only showBeadAsync proves the bead reads back.
    const detail = await showBeadAsync('task', dup.id)
    requireVerified({ operation: 'updated', id: dup.id, store: 'task', verified: detail !== null })
    return { mode: 'updated', id: dup.id, duplicateOf: dup.id, slug, promoted, detail: detail!.slice(0, 1200) }
  }
  const extraLabels = (input.labels ?? []).map(cleanLabel).filter((x): x is string => !!x)
  const labels = [...(slug ? [`project:${slug}`] : []), ...extraLabels].slice(0, 10)
  const created = await createBead({ store: 'task', title, description: input.description?.slice(0, 4000), labels })
  requireVerified({ operation: 'created', id: created.id, store: 'task', verified: created.verified })
  await maybePromote()
  return { mode: 'created', id: created.id, slug, promoted, detail: created.detail }
}

export interface DispatchInput {
  instruction: string
  taskId?: string
  taskTitle?: string
  project?: string
  target?: string
}

export async function requestDispatch(input: DispatchInput): Promise<{ id: string; slug?: string; taskRef?: string; detail: string }> {
  const instruction = input.instruction.trim()
  if (!instruction) throw new Error('instruction is required')
  let slug: string | undefined
  if (input.project?.trim()) {
    const found = await lookupProject(input.project.trim())
    if (!found) throw new Error(`unknown project: ${input.project}`)
    slug = found.slug
  }
  let taskRef: string | undefined
  if (input.taskId?.trim()) {
    const clean = input.taskId.trim()
    const store = storeFromId(clean)
    if (!store) throw new Error(`unknown task id: ${clean}`)
    const body = await showBeadAsync(store, clean)
    if (!body) throw new Error(`task not found: ${clean}`)
    taskRef = clean
    if (!slug) {
      const m = body.match(/project:([A-Za-z0-9][A-Za-z0-9_-]{1,64})/)
      if (m) slug = m[1]
    }
  } else if (input.taskTitle?.trim()) {
    const { rows } = runList('task', slug ? [`project:${slug}`] : [], [], {
      exclude: [],
      title: input.taskTitle.trim().slice(0, 60),
      status: undefined,
      limit: 10,
      allStates: true,
    })
    const dup = findDuplicate(input.taskTitle.trim(), rows, 0.5)
    if (dup) taskRef = dup.id
  }
  const title = `Dispatch: ${snippet(taskRef ?? input.taskTitle?.trim() ?? instruction.split('\n')[0], 80)}`.slice(0, 200)
  const body = [
    `instruction: ${instruction.slice(0, 2500)}`,
    taskRef ? `task: ${taskRef}` : null,
    input.target?.trim() ? `target: ${input.target.trim().slice(0, 200)}` : null,
    ``,
    `relay did not execute this work. An external agent should claim it.`,
  ].filter((x): x is string => x !== null).join('\n')
  const dispatched = await createBead({ store: 'task', title, description: body, labels: dispatchLabels(slug) })
  requireVerified({ operation: 'created', id: dispatched.id, store: 'task', verified: dispatched.verified })
  return { id: dispatched.id, slug, taskRef, detail: dispatched.detail }
}

export const VERIFY_STORES = ['task', 'stories', 'brain', 'projects', 'ideas', 'friction']

export interface VerifyHit {
  id: string
  title: string
  store: string
}

export async function verifyWork(query: string, store?: string): Promise<{ found: boolean; hits: VerifyHit[]; detail: string }> {
  const q = query.trim()
  if (!q) throw new Error('query is required')
  const idStore = storeFromId(q)
  if (idStore && (!store || store === idStore)) {
    const [body, comments] = await Promise.all([
      beadText(idStore, ['show', q]),
      beadText(idStore, ['comments', q]),
    ])
    const found = !/unknown|no such|not found/i.test(body.slice(0, 200))
    return {
      found,
      hits: found ? [{ id: q, title: body.split('\n')[0].slice(0, 160), store: idStore }] : [],
      detail: found ? (comments ? `${body}\n\n## Comments\n${comments}` : body).slice(0, 2000) : `no bead ${q} in ${idStore}`,
    }
  }
  const stores = (store ? [store] : VERIFY_STORES).filter((s) => STORES.includes(s))
  if (!stores.length) throw new Error(`unknown store: ${store}`)
  const per = await mapLimit(stores, 4, async (s) => {
    try {
      const { rows } = await runListAsync(s, [], [], {
        exclude: [],
        title: q.slice(0, 80),
        status: undefined,
        limit: 8,
        allStates: true,
      })
      return rows.map((r: Row) => ({ id: r.id, title: r.title, store: s }))
    } catch {
      return [] as VerifyHit[]
    }
  })
  const hits = per.flat().slice(0, 20)
  if (!hits.length) return { found: false, hits, detail: `no matches for "${q.slice(0, 120)}" in ${stores.join(', ')}` }
  const top = hits[0]
  const detail = await beadText(top.store, ['show', top.id]).then((b) => b.slice(0, 1500))
  return { found: true, hits, detail }
}

export interface FlowInput {
  instruction: string
  taskTitle: string
  taskDescription?: string
  projectHint?: string
  dispatchInstruction?: string
  dryRun?: boolean
}

export async function runFlow(input: FlowInput): Promise<FlowResult> {
  const steps: FlowStep[] = []
  let project: ProjectCandidate | undefined
  let taskId: string | undefined
  let dispatchId: string | undefined
  let promoted = false
  if (input.projectHint?.trim()) {
    try {
      const found = await resolveProject(input.projectHint.trim(), 1)
      if (found.length) {
        project = found[0]
        steps.push({ name: 'resolve-project', ok: true, detail: `${project.id} (${project.state}) via ${project.via}` })
      } else {
        steps.push({ name: 'resolve-project', ok: false, detail: `no project match for "${input.projectHint.trim().slice(0, 120)}"` })
      }
    } catch (e) {
      steps.push({ name: 'resolve-project', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  } else {
    steps.push({ name: 'resolve-project', ok: true, detail: 'skipped (no project hint)' })
  }
  if (input.dryRun) {
    try {
      const { rows } = runList('task', project && !project.backlog ? [`project:${project.slug}`] : [], [], {
        exclude: [],
        title: input.taskTitle.slice(0, 60),
        status: undefined,
        limit: 10,
        allStates: true,
      })
      const dup = findDuplicate(input.taskTitle, rows)
      steps.push({ name: 'dry-run-duplicate-check', ok: true, detail: dup ? `would update ${dup.id}` : 'would create (no duplicate)' })
    } catch (e) {
      steps.push({ name: 'dry-run-duplicate-check', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
    return { steps, project, complete: steps.every((s) => s.ok) }
  }
  try {
    const up = await upsertTask({
      title: input.taskTitle,
      description: input.taskDescription,
      project: project?.id ?? input.projectHint,
    })
    taskId = up.id
    promoted = up.promoted
    steps.push({ name: 'create/update-task', ok: true, detail: `${up.mode} ${up.id}${up.promoted ? ' (promoted project)' : ''}` })
    if (!project && up.slug) {
      const rows = await fetchProjectRows(200)
      const row = rows.find((r) => slugOf(r.labels, r.title) === up.slug)
      if (row) {
        const state = projectState(row.labels)
        project = { id: row.id, slug: up.slug, title: row.title, state, backlog: state === 'backlog', score: 0, via: 'task-label' }
      }
    }
  } catch (e) {
    steps.push({ name: 'create/update-task', ok: false, detail: e instanceof Error ? e.message : String(e) })
    return { steps, project, complete: false }
  }
  if (input.dispatchInstruction?.trim()) {
    try {
      const d = await requestDispatch({
        instruction: input.dispatchInstruction.trim(),
        taskId,
        project: project?.id,
      })
      dispatchId = d.id
      steps.push({ name: 'request-dispatch', ok: true, detail: `dispatch ${d.id} for ${taskId} (not executed)` })
    } catch (e) {
      steps.push({ name: 'request-dispatch', ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  } else {
    steps.push({ name: 'request-dispatch', ok: true, detail: 'skipped (no dispatch instruction)' })
  }
  return { steps, project, taskId, dispatchId, promoted, complete: steps.every((s) => s.ok) }
}

export function formatResolve(cands: ProjectCandidate[]): string {
  if (!cands.length) return `# resolve — no match\n\nNo foreground or backlog project matches. Create routing needs a human decision.`
  const lines = cands.map((c) => `- ${c.id} — ${c.title} [${c.state}]${c.backlog ? ' (backlog match)' : ''} slug=${c.slug} via=${c.via}${c.description ? `\n  ${c.description.slice(0, 200)}` : ''}`)
  return [`# resolve (${cands.length})`, ``, ...lines, ``, `Resolve before creating or routing work. Mentioning a backlog project does not promote it; creating a bead for it does.`].join('\n')
}

export function formatProjectList(rows: RankRow[], scope: string): string {
  if (!rows.length) return `# projects (${scope}) — none`
  return [`# projects (${scope}, ${rows.length})`, ``, ...rows.map((r) => {
    const state = projectState(r.labels)
    return `- ${r.id} — ${r.title} [${state}]${state === 'backlog' ? ' (backlog)' : ''}`
  })].join('\n')
}

export function formatVerify(found: boolean, hits: VerifyHit[], detail: string): string {
  const head = found ? `# verify — found (${hits.length})` : `# verify — not found`
  const lines = hits.slice(0, 10).map((h) => `- ${h.id} — ${h.title} [${h.store}]`)
  return [head, ``, ...lines, ``, detail].join('\n')
}

export function formatFlow(r: FlowResult): string {
  const lines = r.steps.map((s) => `- ${s.name}: ${s.ok ? 'ok' : 'FAILED'} — ${s.detail}`)
  return [
    `# flow — ${r.complete ? 'complete' : 'partial failure'}`,
    ``,
    ...lines,
    ...(r.project ? [``, `project: ${r.project.id} [${r.project.state}]`] : []),
    ...(r.taskId ? [`task: ${r.taskId}`] : []),
    ...(r.dispatchId ? [`dispatch: ${r.dispatchId}`] : []),
    ...(r.promoted ? [`promoted backlog project to foreground`] : []),
  ].join('\n')
}

export async function listProjectsScoped(scope: string, query?: string, limit = 20): Promise<RankRow[]> {
  const lim = Math.max(1, Math.min(50, limit))
  const q = query?.trim()
  if (q) {
    const { rows } = runList('projects', [], [], { exclude: [], title: q.slice(0, 80), status: undefined, limit: 50, allStates: true })
    const filtered = scope === 'foreground'
      ? rows.filter((r) => projectState(r.labels) === 'foreground')
      : scope === 'backlog'
        ? rows.filter((r) => projectState(r.labels) === 'backlog')
        : rows
    return filtered.slice(0, lim)
  }
  if (scope === 'foreground') {
    return runList('projects', ['state:foreground'], [], { exclude: [], status: undefined, limit: lim, allStates: true }).rows
  }
  return runList('projects', [], [], { exclude: [], status: undefined, limit: lim, allStates: true }).rows.filter((r) =>
    scope === 'backlog' ? projectState(r.labels) === 'backlog' : true,
  )
}

export async function checkRelayStores(): Promise<{ store: string; ok: boolean }[]> {
  const need = ['projects', 'task', 'brain', 'ideas', 'friction']
  const out: { store: string; ok: boolean }[] = []
  for (const s of need) {
    try {
      await execStdout(s, ['list', '--json', '--limit', '1'], 12000)
      out.push({ store: s, ok: true })
    } catch {
      out.push({ store: s, ok: STORES.includes(s) })
    }
  }
  return out
}
