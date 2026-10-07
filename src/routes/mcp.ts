// MCP endpoint (Vercel mcp-handler) over the same underlying operations
// as the GET fetcher routes — no HTTP to self. Tools call beadText/runList/bd
// directly. Mounted before readRouter's /:store catchall so /mcp isn't
// swallowed by a param route.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { MAX_BODY_CHARS, bodyText, requiredBodyText } from '../lib/limits'
import { BASE, STORES, toolKey } from '../config'
import { storeFromId } from '../util'
import {
  ambiguousBeadIdError,
  ambiguousStoreError,
  resolveBeadStore,
  resolveStoreName,
  unknownBeadIdError,
  unknownStoreError,
} from '../lib/store-aliases'
import { beadText, mapLimit } from '../lib/exec'
import { bundleIds } from './beads'
import { runList } from './query/store'
import { cleanLabel, LABEL_RE } from './query/params'
import { validateCreateLabels } from '../lib/create'
import { createOperationBead, formatReconciliation } from '../lib/idempotent-create'
import { DEP_TYPES, MAX_BATCH_BEADS, formatBatch, runBatch } from '../lib/batch'
import { beadConnections, formatConnections } from '../lib/connections'
import { feedbackDir, writeFeedback } from '../lib/feedback'
import { editBead } from '../lib/edit'
import { formatWhoami, loadProfile, readWhoamiNotes, serverVersion, updateProfile } from '../lib/whoami'
import { appendPersonality, editPersonalitySection, ensurePersonality, loadPersonality, savePersonality, PERSONALITY_MAX_CHARS } from '../lib/personality'
import { backendCommit, BRIDGE_OP_NAMES, capabilitiesSince, capabilityStatus, formatBridgeInfo, isSemver, loadManifest, schemaHash, whoamiDescription } from '../lib/capabilities'
import { findWildcard, formatWildcardDescribe, formatWildcardInvoke, formatWildcardList, formatWildcardSearch, formatWildcardUnknownDescribe, invokeWildcard, searchWildcards } from '../lib/wildcard'
import { checkSurface, extractRecordedTriple, formatSurfaceCheck, latestFeedbackFilename, readFeedbackRecord } from '../lib/surface-compare'
import { scratchAppend, scratchClear, scratchRead } from '../lib/scratchpad'
import { pickStores, gatherCandidates, sampleIndices, formatPicks } from '../lib/random'
import { sendFetchResponse, toFetchRequest } from '../lib/express-fetch'
import { lookupAccess, mcpResource } from '../lib/oauth'
import { LOOPBACK, hasForwardMarkers, socketPeer } from '../lib/access-gate'
import { withCompatRequest } from '../lib/mcp-compat'
import { withTelemetry } from '../lib/mcp-telemetry'
import { withActivity } from '../lib/activity'
import { captureEntry, editProject, formatFlow, formatProjectEdit, formatProjectList, formatResolve, formatVerify, listProjectsScoped, requestDispatch, resolveProject, runFlow, upsertTask, verifyWork } from '../lib/relay'
import { closeBead, commentBead, formatReceipt, labelBead, noteBead } from '../lib/mutate'
import { unverifiedMessage } from '../lib/receipts'
import { formatRelayStatus, relayStatus, relayStatusReading } from '../lib/relay-status'
import { currentScope, registerFollowon, withFollowonScope, withResponseFooter } from '../lib/followons'
import { currentRequestCaller, withProvenance } from '../lib/provenance'
import { HEARTBEAT_CALLER_ANONYMOUS, HEARTBEAT_CALLER_LOOPBACK, HEARTBEAT_EXCLUDED_TOOLS, advanceHeartbeatCursor, heartbeatReading, peekHeartbeatBlock, renderHeartbeatBlock } from '../lib/heartbeat'
import { agentPresence, formatPresence } from '../lib/agent-mail'
import { recordLatestHeartbeat } from '../lib/heartbeat-latest'
import { relayCatchup } from '../lib/catchup'
import { attentionNext } from '../lib/attention'
import { inspectRead, inspectReadMany, inspectSearch, inspectTree } from '../lib/inspect'
import { formatProbeResult, runDelayProbe, validateCorrelationId, validateDelaySeconds } from '../lib/delay-probe'
import {
  attachHistory,
  attachClaimedDetail,
  CLAIMED_DETAIL_MAX_BEADS,
  claimedBeads,
  clampLimit,
  cleanLabels,
  federatedSearch,
  formatActivity,
  formatClaimed,
  formatSearch,
  formatSnapshot,
  pickRetrievalStores,
  recentActivity,
  reconstructSnapshot,
  staleAfterMsFromHours,
  SNAPSHOT_DEFAULT_CAP,
  SNAPSHOT_DEFAULT_DEPTH,
  SNAPSHOT_MAX_CAP,
  SNAPSHOT_MAX_DEPTH,
} from '../lib/retrieval'

export const mountOrder = -20
export const mcpRouter = Router()

const text = (t: string) => ({ type: 'text' as const, text: t })

// The MCP response boundary intentionally composes only MCP footers. Web/chat
// navigation is rendered by wrap.ts for GET routes and must never be added to
// a tool result: it includes queue links and write-oriented paste URLs that
// are meaningless (and distracting) to an MCP client.
function composeMcpText(body: string, outcome: 'ok' | 'error', bare: boolean): string {
  return bare ? body : withResponseFooter(body, outcome)
}

const ok = (t: string, bare = false) => ({ content: [text(composeMcpText(t, 'ok', bare))] })
const err = (t: string, bare = false) => ({ content: [text(composeMcpText(t, 'error', bare))], isError: true as const })

// Machine-readable timing payload (task-60f3z). A rendered age is a
// convenience; the CONSUMER must be able to compute its own delta, so the
// read time and each item's source/touch timestamp + basis ship as data
// alongside the prose. Kept as a separate text block (every MCP client
// surfaces it, no output-schema negotiation required).
function withTiming(t: string, payload: unknown, bare: boolean): { content: { type: 'text'; text: string }[] } {
  const body = bare ? t : withResponseFooter(t, 'ok')
  return {
    content: [
      text(body),
      text(`timing (JSON — readAt is the read time; age = readAtMs - <event|touched>.atMs; basis "source" means that is the event's own timestamp, "touch" means it is only the bridge's touch):\n${JSON.stringify(payload)}`),
    ],
  }
}

// Heartbeat as the default follow-on (task-ksmy1, consumption fixed by
// task-36na1): every footered response carries the caller's pending delta,
// PEEKED — projected without advancing the cursor — so an intervening call
// can report an async event but never silently consume it. Only explicit
// `heartbeat` / `relay_status` reads acknowledge (advance the cursor).
// Bare tools (heartbeat itself, relay_status, timeout_probe) stay bare —
// footer output never re-triggers a follow-on (loop prevention).
registerFollowon({
  name: 'heartbeat',
  priority: 100,
  excludeTools: HEARTBEAT_EXCLUDED_TOOLS,
  run: (ctx) => {
    const text = peekHeartbeatBlock(ctx.caller, { now: ctx.at })
    // Feed the persistent /live heartbeat surface (observational only:
    // recording never throws and never alters the response).
    try {
      recordLatestHeartbeat({ caller: ctx.caller, origin: 'footer', text, now: ctx.at })
    } catch {
      /* observation never fails a response */
    }
    return text
  },
})

// Canonical store for a bead id, with loud ambiguity: an id prefix that
// could belong to more than one store names the candidates instead of
// guessing. Returns the error text (caller wraps with err()).
function beadStore(id: string): { store: string } | { error: string } {
  const clean = id.trim()
  const r = resolveBeadStore(clean)
  if (r.kind === 'ambiguous') return { error: ambiguousBeadIdError(clean, r.prefix, r.candidates) }
  const store = storeFromId(clean)
  if (!store) return { error: unknownBeadIdError(id) }
  return { store }
}

async function showBead(id: string): Promise<string> {
  const resolved = resolveBeadStore(id.trim())
  if (resolved.kind === 'ambiguous') {
    return ambiguousBeadIdError(id.trim(), resolved.prefix, resolved.candidates)
  }
  const store = storeFromId(id)
  if (!store) return unknownBeadIdError(id)
  relayStatus.markVerified(id.trim())
  const [body, comments] = await Promise.all([
    beadText(store, ['show', id]),
    beadText(store, ['comments', id]),
  ])
  return [`# ${id} (STORE: ${store})`, '', comments ? `${body}\n\n## Comments\n${comments}` : body].join('\n')
}

const mcpHandler = createMcpHandler((server) => {
  // GET /{bead-id} equivalent.
  server.registerTool(
    'bead_show',
    {
      title: 'Show bead',
      description: 'Show a bead with its comments (same as GET /{bead-id})',
      inputSchema: z.object({ id: z.string().describe('Bead id, e.g. review-3y3') }),
    },
    async ({ id }: { id: string }) => ok(await showBead(id.trim())),
  )

  // GET /beads/{id1+id2+...} equivalent (up to 40).
  server.registerTool(
    'beads_bundle',
    {
      title: 'Show bead bundle',
      description: 'Show up to 40 beads at once (same as GET /beads/{ids})',
      inputSchema: z.object({ ids: z.array(z.string()).max(40).describe('Bead ids') }),
    },
    async ({ ids }: { ids: string[] }) => {
      const valid = bundleIds(ids)
      if (!valid.length) return err('No valid bead ids.')
      const parts = await mapLimit(valid, 12, showBead)
      return ok(parts.join('\n\n---\n\n'))
    },
  )

  // GET /q/:store equivalent.
  server.registerTool(
    'query_store',
    {
      title: 'Query store',
      description: 'Label/text query over one bead store (same as GET /q/:store)',
      inputSchema: z.object({
        store: z.string().describe('Store name, e.g. resumes-zak'),
        label: z.array(z.string()).optional().describe('AND labels'),
        any: z.array(z.string()).optional().describe('OR labels'),
        exclude: z.array(z.string()).optional().describe('Excluded labels'),
        title: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Max rows (default 20)'),
      }),
    },
    async ({ store, label, any, exclude, title, status, limit }: {
      store: string; label?: string[]; any?: string[]; exclude?: string[];
      title?: string; status?: string; limit?: number
    }) => {
      const req = resolveStoreName(store ?? '')
      if (req.kind === 'ambiguous') return err(ambiguousStoreError(req.requested, req.candidates))
      if (req.kind === 'unknown') return err(unknownStoreError(store))
      store = req.store
      const aliasNote = req.kind === 'alias' ? ` (resolved alias '${req.requested}' → canonical '${req.store}')` : ''
      const all = (label ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10)
      const orLabels = (any ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10)
      // No filters means list-all (up to limit) — store discovery is a feature.
      const { rows, error } = runList(store, all, orLabels, {
        exclude: (exclude ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10),
        title: title?.slice(0, 120),
        status: status?.slice(0, 64),
        limit: limit ?? 20,
        allStates: false,
      })
      const lines = rows.map((r) => `${r.id} — ${r.title}${r.labels.length ? ` [${r.labels.join(', ')}]` : ''}`)
      return ok([`# query — ${store} (${rows.length})${aliasNote}`, '', ...lines, ...(error ? ['', `error: ${error}`] : [])].join('\n'))
    },
  )

  // GET /{id}/comment and /{id}/note equivalents. Shell-free argv —
  // $, backticks, quotes, and newlines pass through literally.
  server.registerTool(
    'bead_comment',
    {
      title: 'Comment on bead',
      description: 'Add a comment (same as GET /{id}/comment). Only report success when this call returns a receipt — report IDs verbatim from tool output, never from inference.',
      inputSchema: z.object({ id: z.string(), text: z.string().describe('Comment text') }),
    },
    async ({ id, text: t }: { id: string; text: string }) => {
      const clean = id.trim()
      const bs = beadStore(id)
      if ('error' in bs) return err(bs.error)
      const store = bs.store
      if (!t.trim()) return err('Missing text.')
      try {
        const r = await commentBead(store, clean, t)
        relayStatus.touch({ id: r.id, kind: 'note', title: t.trim().slice(0, 120) })
        // False-success guardrail: unverified is an error naming the bead,
        // never a success.
        if (!r.verified) {
          relayStatus.touch({ id: r.id, kind: 'verify', title: t.trim().slice(0, 120), needsVerify: true })
          return err(unverifiedMessage(r))
        }
        return ok(formatReceipt(r))
      } catch (e) {
        relayStatus.touch({ id: clean, kind: 'failure', title: `comment failed ${clean}`, state: 'failed' })
        return err(`comment failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'bead_note',
    {
      title: 'Note on bead',
      description: 'Append a note (same as GET /{id}/note). Only report success when this call returns a receipt — report IDs verbatim from tool output, never from inference.',
      inputSchema: z.object({ id: z.string(), text: z.string().describe('Note text') }),
    },
    async ({ id, text: t }: { id: string; text: string }) => {
      const clean = id.trim()
      const bs = beadStore(id)
      if ('error' in bs) return err(bs.error)
      const store = bs.store
      if (!t.trim()) return err('Missing text.')
      try {
        const r = await noteBead(store, clean, t)
        relayStatus.touch({ id: r.id, kind: 'note', title: t.trim().slice(0, 120) })
        if (!r.verified) {
          relayStatus.touch({ id: r.id, kind: 'verify', title: t.trim().slice(0, 120), needsVerify: true })
          return err(unverifiedMessage(r))
        }
        return ok(formatReceipt(r))
      } catch (e) {
        relayStatus.touch({ id: clean, kind: 'failure', title: `note failed ${clean}`, state: 'failed' })
        return err(`note failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // approve/reject/done/close equivalents (same sequences as verbs.ts).
  server.registerTool(
    'bead_decision',
    {
      title: 'Decide bead',
      description: 'approve/reject/done/close a bead (same as GET /{id}/approve etc.). Only report success when this call returns a receipt — report IDs verbatim from tool output, never from inference.',
      inputSchema: z.object({
        id: z.string(),
        decision: z.enum(['approve', 'reject', 'done', 'close']),
      }),
    },
    async ({ id, decision }: { id: string; decision: 'approve' | 'reject' | 'done' | 'close' }) => {
      const clean = id.trim()
      const bs = beadStore(id)
      if ('error' in bs) return err(bs.error)
      const store = bs.store
      const ts = new Date().toISOString()
      try {
        if (decision === 'approve') {
          const c = { ...(await commentBead(store, clean, `Approved via beads-bridge ${ts}`)), operation: 'approved' }
          const k = { ...(await closeBead(store, clean)), operation: 'closed' }
          const bad = [c, k].find((x) => !x.verified)
          if (bad) {
            relayStatus.touch({ id: clean, kind: 'verify', title: `Approved + closed ${clean}`, needsVerify: true })
            return err(unverifiedMessage(bad))
          }
          relayStatus.markDone(clean) ?? relayStatus.touch({ id: clean, kind: 'completion', title: `Approved + closed ${clean}`, state: 'done' })
          return ok([formatReceipt(c), '', formatReceipt(k)].join('\n'))
        }
        if (decision === 'reject') {
          const c = { ...(await commentBead(store, clean, `Rejected via beads-bridge ${ts}`)), operation: 'rejected' }
          if (!c.verified) {
            relayStatus.touch({ id: clean, kind: 'verify', title: `Rejected ${clean}`, needsVerify: true })
            return err(unverifiedMessage(c))
          }
          relayStatus.touch({ id: clean, kind: 'note', title: `Rejected ${clean} — needs human`, state: 'waiting' })
          return ok(formatReceipt(c))
        }
        if (decision === 'done') {
          const c = { ...(await commentBead(store, clean, `Handled via beads-bridge ${ts}`)), operation: 'handled' }
          const k = { ...(await closeBead(store, clean)), operation: 'closed' }
          const bad = [c, k].find((x) => !x.verified)
          if (bad) {
            relayStatus.touch({ id: clean, kind: 'verify', title: `Handled + closed ${clean}`, needsVerify: true })
            return err(unverifiedMessage(bad))
          }
          relayStatus.markDone(clean) ?? relayStatus.touch({ id: clean, kind: 'completion', title: `Handled + closed ${clean}`, state: 'done' })
          return ok([formatReceipt(c), '', formatReceipt(k)].join('\n'))
        }
        const k = await closeBead(store, clean)
        if (!k.verified) {
          relayStatus.touch({ id: clean, kind: 'verify', title: `Closed ${clean}`, needsVerify: true })
          return err(unverifiedMessage(k))
        }
        relayStatus.markDone(clean) ?? relayStatus.touch({ id: clean, kind: 'completion', title: `Closed ${clean}`, state: 'done' })
        return ok(formatReceipt(k))
      } catch (e) {
        relayStatus.touch({ id: clean, kind: 'failure', title: `${decision} failed ${clean}`, state: 'failed' })
        return err(`${decision} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // GET /{id}/label equivalent.
  server.registerTool(
    'bead_label',
    {
      title: 'Label bead',
      description: 'Add/remove labels (same as GET /{id}/label). Only report success when this call returns a receipt — report IDs verbatim from tool output, never from inference.',
      inputSchema: z.object({
        id: z.string(),
        add: z.string().optional(),
        remove: z.string().optional(),
      }),
    },
    async ({ id, add, remove }: { id: string; add?: string; remove?: string }) => {
      const clean = id.trim()
      const bs = beadStore(id)
      if ('error' in bs) return err(bs.error)
      const store = bs.store
      if (!add && !remove) return err('Give add and/or remove.')
      try {
        const r = await labelBead(store, clean, { add, remove })
        relayStatus.touch({ id: clean, kind: 'note', title: `labels updated ${clean}` })
        if (!r.verified) {
          relayStatus.touch({ id: clean, kind: 'verify', title: `labels updated ${clean}`, needsVerify: true })
          return err(unverifiedMessage(r))
        }
        return ok(formatReceipt(r))
      } catch (e) {
        relayStatus.touch({ id: clean, kind: 'failure', title: `label failed ${clean}`, state: 'failed' })
        return err(`label failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // No GET equivalent (the fetcher bridge is read/decide-only): create a
  // bead. Labels are caller-chosen and validated like query labels — use
  // project:<slug> to attach to a project, resume:<id> for scope.
  // See /guide/labels for the taxonomy.
  server.registerTool(
    'bead_create',
    {
      title: 'Create bead',
      description: 'Create a new bead in a store. Labels attach it: project:<slug> links to a project, resume:<id> scopes it to a resume. Supply operation_id (a logical id you choose and reuse for retried or continued versions of the SAME request): repeat submissions with one operation_id are reconciled onto ONE bead as revisions — never duplicates. Only report success when this call returns a receipt — report the ID verbatim from tool output, never from inference.',
      inputSchema: z.object({
        store: z.string().describe('Store name, e.g. task, stories, brain'),
        title: z.string().min(1).max(200).describe('Bead title'),
        description: bodyText('Body text'),
        labels: z.array(z.string()).max(10).optional().describe('Labels, e.g. project:parlay — invalid ones are rejected'),
        parent: z.string().optional().describe('Parent bead id for hierarchy'),
        operation_id: z.string().min(1).max(200).optional().describe('Logical operation id for this request. Reuse the SAME value for retries, replays, or a continuation turn that adds scope; each reuse is recorded as a revision of the one bead instead of creating another. Omit it for a plain one-off create (no key, no revision history).'),
        promote: z.boolean().optional().describe('With operation_id on an existing action: the added scope is materially DISTINCT work — create it as a child bead of the existing one instead of merging it into the body.'),
      }),
    },
    async ({ store, title, description, labels, parent, operation_id, promote }: {
      store: string; title: string; description?: string; labels?: string[]; parent?: string; operation_id?: string; promote?: boolean
    }) => {
      const req = resolveStoreName(store ?? '')
      if (req.kind === 'ambiguous') return err(ambiguousStoreError(req.requested, req.candidates))
      if (req.kind === 'unknown') return err(unknownStoreError(store))
      store = req.store
      const createAliasNote = req.kind === 'alias' ? ` (resolved alias '${req.requested}' → canonical '${req.store}')` : ''
      if (parent?.trim()) {
        const pstore = storeFromId(parent.trim())
        if (!pstore) {
          const pr = resolveBeadStore(parent.trim())
          if (pr.kind === 'ambiguous') return err(ambiguousBeadIdError(parent.trim(), pr.prefix, pr.candidates))
          return err(`unknown parent bead id: ${parent}`)
        }
        if (pstore !== store) return err(`parent lives in ${pstore}, not ${store}`)
      }
      const { ok: valid, bad } = validateCreateLabels(labels)
      if (bad.length) return err(`bad label: ${bad.join(', ')} (match ${LABEL_RE}, max 64 chars)`)
      try {
        const provenance = { source: 'mcp' as const, caller: currentRequestCaller() }
        const { id, detail, verified, disposition, revision, operationKey, applied, childId } = await createOperationBead({
          store,
          title,
          description,
          labels: valid,
          parent: parent?.trim() || undefined,
          operationId: operation_id,
          promote: promote === true,
          provenance,
        })
        relayStatus.touch({ id, kind: 'task', title })
        const receipt = { operation: disposition === 'created' ? 'created' : `${disposition} of existing bead`, id, store, verified, detail }
        if (!verified) {
          relayStatus.touch({ id, kind: 'verify', title, needsVerify: true })
          return err(unverifiedMessage(receipt))
        }
        const idem = operationKey ? `\n${formatReconciliation({ disposition, id, operationKey, revision, applied, childId })}` : ''
        return ok(formatReceipt(receipt, `Labels: ${withProvenance(valid, provenance).join(', ') || '(none)'}${createAliasNote}${idem}`))
      } catch (e) {
        relayStatus.touch({ id: `new:${store}`, kind: 'failure', title: `create failed in ${store}: ${title}`, state: 'failed' })
        return err(`create failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Atomic multi-bead graph creation: one call creates a whole bead graph.
  // Later beads refer to earlier ones by intra-batch name (resolved to
  // canonical IDs at commit); parent/child, depends_on, and generic typed
  // relations are declared in the batch. Validation failures reject the
  // whole batch before any write; runtime failures report exactly what
  // landed and what did not. Only report success from the returned receipt —
  // report IDs verbatim from tool output, never from inference.
  server.registerTool(
    'bead_batch_create',
    {
      title: 'Create bead graph',
      description: `Create a whole bead graph atomically (max ${MAX_BATCH_BEADS} beads): named intra-batch refs, parent/child, dependencies, typed relations (${(DEP_TYPES as readonly string[]).join('|')} plus cross-store Brain vocabulary: source|provenance|derived-from|destination|recorded-in). Refs must point to earlier beads; parent stays in one store, deps/relations may span stores (cross-store legs land as typed mention-links, verified + traversable).`,
      inputSchema: z.object({
        beads: z.array(z.object({
          name: z.string().min(1).max(64).describe('Intra-batch name, e.g. root — later beads refer to it'),
          store: z.string().describe('Store name, e.g. task'),
          title: z.string().min(1).max(200).describe('Bead title'),
          description: bodyText('Body text'),
          labels: z.array(z.string()).max(10).optional().describe('Labels — invalid ones reject the batch'),
          parent: z.string().optional().describe('Parent: earlier batch name or canonical bead id (same store as the bead)'),
          depends_on: z.array(z.string()).max(20).optional().describe('Dependencies: earlier batch names or bead ids (any store; cross-store legs land as mention-links)'),
        })).min(1).max(MAX_BATCH_BEADS).describe('Beads in commit order'),
        relations: z.array(z.object({
          from: z.string().describe('Batch name or bead id'),
          to: z.string().describe('Batch name or bead id'),
          type: z.string().describe(`Edge type: ${(DEP_TYPES as readonly string[]).join('|')} plus source|provenance|derived-from|destination|recorded-in`),
        })).max(40).optional().describe('Generic typed relations (any store; cross-store legs land as verified mention-links)'),
      }),
    },
    async ({ beads, relations }: {
      beads: { name: string; store: string; title: string; description?: string; labels?: string[]; parent?: string; depends_on?: string[] }[]
      relations?: { from: string; to: string; type: string }[]
    }) => {
      for (const b of beads) {
        const br = resolveStoreName(b.store ?? '')
        if (br.kind === 'ambiguous') return err(`bead "${b.name}": ${ambiguousStoreError(br.requested, br.candidates)}`)
        if (br.kind === 'unknown') return err(`bead "${b.name}": ${unknownStoreError(b.store)}`)
        b.store = br.store
      }
      try {
        const r = await runBatch({ beads, relations }, undefined, { caller: currentRequestCaller() })
        for (const bead of r.beads) {
          relayStatus.touch({ id: bead.id, kind: 'task', title: bead.name })
          if (!bead.verified) relayStatus.touch({ id: bead.id, kind: 'verify', title: bead.name, needsVerify: true })
        }
        for (const f of r.failures) {
          relayStatus.touch({ id: f.target, kind: 'failure', title: `batch: ${f.target} — ${f.error.slice(0, 120)}`, state: 'failed' })
        }
        return r.complete ? ok(formatBatch(r)) : err(formatBatch(r))
      } catch (e) {
        return err(`batch rejected (nothing written): ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // One bead's full connection graph: typed deps both ways, hierarchy,
  // same-label beads, mentioned ids. Replaces four manual steps.
  server.registerTool(
    'bead_connections',
    {
      title: 'Bead connections',
      description: 'All beads connected to one bead: dependencies, dependents, children, parent, same project/resume labels, mentioned ids.',
      inputSchema: z.object({ id: z.string().describe('Bead id, e.g. resumes-zak') }),
    },
    async ({ id }: { id: string }) => {
      relayStatus.markVerified(id.trim())
      const set = await beadConnections(id.trim())
      return 'error' in set ? err(set.error) : ok(formatConnections(set))
    },
  )

  // Revise an existing bead's title and/or description (scriptable update).
  server.registerTool(
    'bead_edit',
    {
      title: 'Edit bead',
      description: 'Revise a bead\'s title and/or description. Give at least one. Only report success when this call returns a receipt — report IDs verbatim from tool output, never from inference.',
      inputSchema: z.object({
        id: z.string().describe('Bead id'),
        title: z.string().min(1).max(200).optional().describe('New title'),
        description: bodyText('New description'),
      }),
    },
    async ({ id, title, description }: { id: string; title?: string; description?: string }) => {
      const clean = id.trim()
      const bs = beadStore(id)
      if ('error' in bs) return err(bs.error)
      const store = bs.store
      try {
        const { detail, verified } = await editBead({ store, id: clean, title, description })
        relayStatus.touch({ id: clean, kind: 'note', title: title ?? `edited ${clean}` })
        const receipt = { operation: 'updated', id: clean, store, verified, detail }
        if (!verified) {
          relayStatus.touch({ id: clean, kind: 'verify', title: title ?? `edited ${clean}`, needsVerify: true })
          return err(unverifiedMessage(receipt))
        }
        return ok(formatReceipt(receipt))
      } catch (e) {
        relayStatus.touch({ id: clean, kind: 'failure', title: `edit failed ${clean}`, state: 'failed' })
        return err(`edit failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Flat-file feedback: free text plus query/time context in frontmatter.
  // Writes under ~/data/feedback (FEEDBACK_DIR overrides) — never the repo.
  server.registerTool(
    'bead_feedback',
    {
      title: 'Submit feedback',
      description: 'File feedback about a bead, a query, or the bridge itself. Say what happened, what you expected, and paste the query that prompted it.',
      inputSchema: z.object({
        text: requiredBodyText('The feedback itself'),
        kind: z.string().max(40).optional().describe('Rough kind: bug, confusion, praise, request, note'),
        bead: z.string().optional().describe('Bead id this is about, if any'),
        query: z.string().max(500).optional().describe('The query or action that prompted this'),
      }),
    },
    async ({ text, kind, bead, query }: { text: string; kind?: string; bead?: string; query?: string }) => {
      try {
        const { filename } = writeFeedback({ text, kind, bead, query })
        return ok(`Feedback filed as ${filename}`)
      } catch (e) {
        return err(`feedback failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Agent orientation: server identity plus the caller's own auth context.
  // Token values are never echoed — only client id, scopes, and expiry.
  server.registerTool(
    'whoami',
    {
      title: 'Who am I here',
      description: whoamiDescription(),
      inputSchema: z.object({}),
    },
    async (
      _args: Record<string, never>,
      ctx?: { http?: { authInfo?: { token: string; clientId: string; scopes: string[] } } },
    ) => {
      const auth = ctx?.http?.authInfo
      const rec = auth?.token ? lookupAccess(auth.token) : null
      // The personality document is the durable bootstrap record: ensured
      // here so whoami always returns the complete text, migrating any
      // legacy profile notes/posture exactly once (idempotent after that).
      const pers = ensurePersonality(loadProfile())
      // Resume context is the operator's own content for their own agents:
      // attach only on the authenticated path, never for unauthenticated.
      const scratch = auth ? readWhoamiNotes() : { notes: [], total: 0 }
      return ok(formatWhoami({
        server: 'beads-bridge',
        version: serverVersion(),
        base: BASE,
        auth: auth
          ? {
            clientId: auth.clientId,
            scopes: auth.scopes ?? [],
            expiresAt: rec?.expiresAt,
            audience: rec?.resource,
          }
          : undefined,
        operator: loadProfile(),
        personalityDoc: pers.doc,
        stores: STORES,
        recentNotes: scratch.notes,
        scratchTotal: scratch.total,
      }))
    },
  )

  // Capability/version contract (task-qgplz): stable introspection so an agent
  // with a stale loaded MCP schema can discover the backend has advanced.
  // BRIDGE_OP_NAMES lives in lib/capabilities.ts (single source shared with
  // the per-response staleness footer); capabilities tests enforce the sync
  // (source registrations == manifest ops == hash input).
  server.registerTool(
    'bridge_info',
    {
      title: 'Bridge version and capability introspection',
      description: 'Stable introspection: backend semver, commit, capability-manifest version, MCP schema hash. Compare against what you loaded at connect; on mismatch ask the user for a manual MCP refresh — an old connection cannot see newly registered tools.',
      inputSchema: z.object({}),
    },
    async () => {
      return ok([
        formatBridgeInfo({ opNames: BRIDGE_OP_NAMES, base: BASE }),
        ``,
        `commit: ${backendCommit()}`,
        `schema: ${schemaHash(BRIDGE_OP_NAMES)}`,
      ].join('\n'))
    },
  )
  server.registerTool(
    'capability_status',
    {
      title: 'Capability status lookup',
      description: 'Is capability id (or originating bead id) live in this backend version? Use to map historical feature requests to shipped capabilities.',
      inputSchema: z.object({
        id: z.string().min(1).max(120).describe('Capability id or originating bead id'),
      }),
    },
    async ({ id }: { id: string }) => {
      const clean = id.trim()
      if (!clean) return err('capability_status: empty id')
      const r = capabilityStatus(loadManifest(), clean)
      if (!r.found) {
        return ok([`# capability_status — ${clean}`, ``, `not in manifest (backend v${r.liveInBackend}). Either unknown id or predates the manifest; check capabilities_since(1.0.0).`].join('\n'))
      }
      const e = r.entry
      const state =
        e.removed != null ? `REMOVED in ${e.removed}`
        : e.deprecated != null ? `DEPRECATED since ${e.deprecated}`
        : `LIVE since ${e.introduced}`
      return ok([
        `# capability_status — ${e.id}`, ``,
        `${e.title} (op: ${e.op}) — ${state} (backend v${r.liveInBackend})`,
        ...(e.beads?.length ? [`originating beads: ${e.beads.join(', ')}`] : []),
      ].join('\n'))
    },
  )
  server.registerTool(
    'capabilities_since',
    {
      title: 'Capabilities changed since version',
      description: 'List capabilities introduced or changed after a semver X.Y.Z. Use with the version your loaded schema understands to learn what a refresh would bring.',
      inputSchema: z.object({
        version: z.string().min(5).max(20).describe('Semver X.Y.Z your schema understands'),
      }),
    },
    async ({ version }: { version: string }) => {
      const clean = version.trim()
      if (!isSemver(clean)) return err(`capabilities_since: '${version}' is not semver X.Y.Z`)
      const rows = capabilitiesSince(loadManifest(), clean)
      if (!rows.length) return ok(`# capabilities_since ${clean}\n\nNothing newer — your schema matches the backend.`)
      return ok([
        `# capabilities_since ${clean} — ${rows.length} newer`, ``,
        ...rows.map((e) => `- ${e.id} (${e.title}, op: ${e.op}) — since ${e.changed ?? e.introduced}`),
      ].join('\n'))
    },
  )

  // Wildcard capability interface (inbox-hkfd): ONE stable outer tool whose
  // schema never changes when sub-capabilities are added. Discovery
  // (search/list/describe) advertises each capability's contract + its
  // read/write effect BEFORE invocation; invoke dispatches by exact stable
  // id with the payload validated against that capability's own contract.
  // NOT an arbitrary-tool/code endpoint: the registry in lib/wildcard.ts
  // is a static compiled-in allowlist of TypeScript handlers — no entry
  // can name another MCP tool or caller-supplied code. Auth: this tool
  // sits inside the same withMcpAuth(required: true) gate as every other
  // tool (no new route, no gate change); handlers get the caller name for
  // attribution only and cannot escalate it.
  server.registerTool(
    'capability',
    {
      title: 'Wildcard capability interface',
      description: 'Stable escape hatch for backend abilities: search/list/describe the registered capability registry by intent, then invoke one by stable id with a structured payload. New capabilities appear here without a client tool-schema refresh. Each entry advertises read-only vs write effect before you invoke; writes return structured receipts.',
      inputSchema: z.object({
        action: z.enum(['search', 'list', 'describe', 'invoke']).describe('search: find capabilities by natural-language intent (needs query). list: every registered id with effect + version. describe: full contract for one id. invoke: run one id with payload.'),
        query: z.string().max(500).optional().describe('search only: natural-language intent, e.g. "resolve resume manifest with provenance"'),
        id: z.string().max(64).optional().describe('describe/invoke only: exact stable capability id from list/search'),
        payload: z.record(z.string(), z.unknown()).optional().describe('invoke only: structured params for the selected capability (unknown params rejected)'),
      }),
    },
    async ({ action, query, id, payload }: {
      action: 'search' | 'list' | 'describe' | 'invoke'; query?: string; id?: string; payload?: Record<string, unknown>
    }) => {
      const caller = currentScope()?.caller ?? HEARTBEAT_CALLER_ANONYMOUS
      if (action === 'list') return ok(formatWildcardList())
      if (action === 'search') {
        const q = query?.trim() ?? ''
        if (!q) return err('capability search: empty query — say what you want to do, or action=list to browse')
        return ok(formatWildcardSearch(q, searchWildcards(q)))
      }
      const clean = id?.trim() ?? ''
      if (!clean) return err(`capability ${action}: empty id — action=list shows every registered id`)
      if (action === 'describe') {
        const def = findWildcard(clean)
        return ok(def ? formatWildcardDescribe(def) : formatWildcardUnknownDescribe(clean))
      }
      const result = await invokeWildcard(clean, payload ?? {}, { caller })
      return result.ok ? ok(formatWildcardInvoke(result, { caller })) : err(formatWildcardInvoke(result, { caller }))
    },
  )

  // Tool-surface comparison (task-trv5y): observational only — reads the
  // newest feedback record (or the named one), extracts the tool surface
  // it describes, and diffs it against the live surface. A server cannot
  // see a client's loaded tools/list, so a caller may supply its own
  // snapshot (client_tools/client_schema) for a direct check; otherwise
  // the verdict is feedback-vs-live and says so. Bounded output, no writes.
  server.registerTool(
    'tool_surface_check',
    {
      title: 'Tool-surface comparison against latest feedback',
      description: 'Compare the MCP tool surface described in the latest feedback record against the live surface: additions, removals, schema/capability changes, and a needs_refresh verdict. Optionally pass your own loaded tools/list (client_tools) and schema hash (client_schema) for a direct staleness check — without them the verdict is feedback-vs-live and says so explicitly.',
      inputSchema: z.object({
        client_tools: z.string().max(MAX_BODY_CHARS).optional().describe('Your loaded tools/list snapshot: tool names separated by commas, spaces, or newlines'),
        client_schema: z.string().max(128).optional().describe('Schema hash your connection loaded at connect time'),
        feedback: z.string().max(120).optional().describe('Feedback filename to compare against (default: most recent)'),
      }),
    },
    async ({ client_tools, client_schema, feedback }: { client_tools?: string; client_schema?: string; feedback?: string }) => {
      try {
        const dir = feedbackDir()
        const file = feedback?.trim() || latestFeedbackFilename(dir)
        if (!file) return err('tool_surface_check: no feedback records yet — nothing to compare against')
        if (/[/\\]|\.\./.test(file)) return err(`tool_surface_check: bad feedback name '${file}'`)
        let raw: string
        try {
          raw = readFeedbackRecord(dir, file)
        } catch {
          return err(`tool_surface_check: cannot read feedback '${file}'`)
        }
        const recorded = extractRecordedTriple(raw)
        const changedSince = recorded.version
          ? capabilitiesSince(loadManifest(), recorded.version).map((e) => e.id).sort()
          : []
        const m = loadManifest()
        return ok(formatSurfaceCheck(checkSurface({
          feedbackFile: file,
          feedbackText: raw,
          vocabulary: BRIDGE_OP_NAMES,
          liveOps: BRIDGE_OP_NAMES,
          liveTriple: {
            version: serverVersion(),
            manifest: m.manifestVersion,
            commit: backendCommit(),
            schema: schemaHash(BRIDGE_OP_NAMES),
          },
          clientTools: client_tools ?? null,
          clientSchema: client_schema ?? null,
          changedSince,
        })))
      } catch (e) {
        return err(`tool_surface_check failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Operator profile editing for whoami (merge; empty string clears).
  server.registerTool(
    'identity_update',
    {
      title: 'Update operator identity',
      description: 'Set operator profile fields shown by whoami: name, role, timezone, notes, personality, communication, principles, relationship, relay_stance. The notes/posture fields are legacy — their canonical home is now the personality document (see personality_*); writes are still accepted for compatibility.',
      inputSchema: z.object({
        name: z.string().max(500).optional(),
        role: z.string().max(500).optional(),
        timezone: z.string().max(500).optional(),
        notes: z.string().max(500).optional(),
        personality: z.string().max(500).optional(),
        communication: z.string().max(500).optional(),
        principles: z.string().max(500).optional(),
        relationship: z.string().max(500).optional(),
        relay_stance: z.string().max(500).optional(),
      }),
    },
    async (patch: {
      name?: string
      role?: string
      timezone?: string
      notes?: string
      personality?: string
      communication?: string
      principles?: string
      relationship?: string
      relay_stance?: string
    }) => {
      const { profile, bad } = updateProfile(patch as Record<string, unknown>)
      if (bad.length) {
        return err(
          `unknown identity fields: ${bad.join(', ')} (want name, role, timezone, notes, personality, communication, principles, relationship, relay_stance)`,
        )
      }
      const lines = Object.entries(profile).map(([k, v]) => `${k}: ${v}`)
      return ok(['# operator identity updated', '', ...(lines.length ? lines : ['(empty)'])].join('\n'))
    },
  )

  // Personality document (task-xqj24): one durable operator-controlled
  // bootstrap record. Four operations with distinct semantics — read the
  // whole record, replace it wholesale, append to the end, or rewrite one
  // ## section by heading. No 500-char cap anywhere here (whole-document
  // guard only). Every op routes through ensurePersonality, so legacy
  // profile notes/posture migrate exactly once instead of being lost.
  server.registerTool(
    'personality_read',
    {
      title: 'Read personality document',
      description: 'Read the complete operator personality document (startup/bootstrap context). Returns the full text plus whether the file already existed and whether a legacy profile migration seeded it just now.',
      inputSchema: z.object({}),
    },
    async () => {
      const existed = loadPersonality().existed
      const { doc, migrated } = ensurePersonality(loadProfile())
      return ok([
        `# personality (operator document, ${doc.length} chars${existed ? '' : ', default'}${migrated ? ', migrated from operator profile just now' : ''})`,
        '',
        doc,
      ].join('\n'))
    },
  )
  server.registerTool(
    'personality_replace',
    {
      title: 'Replace personality document',
      description: 'Replace the entire personality document with the given markdown. Full overwrite — the old text is gone, so read first. No 500-char cap; the whole-document guard applies.',
      inputSchema: z.object({
        document: z.string().min(1).max(PERSONALITY_MAX_CHARS).describe('Complete new markdown document'),
      }),
    },
    async ({ document }: { document: string }) => {
      try {
        ensurePersonality(loadProfile())
        const { chars } = savePersonality(document)
        return ok(`# personality replaced (${chars} chars).`)
      } catch (e) {
        return err(`personality_replace failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )
  server.registerTool(
    'personality_append',
    {
      title: 'Append to personality document',
      description: 'Append markdown to the end of the personality document (new section, rule, or repertoire entry). The text is added verbatim after a blank line; nothing else changes.',
      inputSchema: z.object({
        text: z.string().min(1).max(100000).describe('Markdown to append'),
      }),
    },
    async ({ text }: { text: string }) => {
      try {
        const { chars } = appendPersonality(text)
        return ok(`# personality appended (now ${chars} chars).`)
      } catch (e) {
        return err(`personality_append failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )
  server.registerTool(
    'personality_section_edit',
    {
      title: 'Edit personality section',
      description: 'Rewrite one ## section of the personality document by heading (case-insensitive, e.g. "Speaking preferences"). Only that section\'s body changes; sub-sections belong to their parent. Unknown headings fail listing the headings that exist.',
      inputSchema: z.object({
        heading: z.string().min(1).max(200).describe('Section heading to rewrite'),
        body: z.string().min(1).max(100000).describe('New markdown body for the section'),
      }),
    },
    async ({ heading, body }: { heading: string; body: string }) => {
      try {
        const { chars } = editPersonalitySection(heading, body)
        return ok(`# personality section '${heading.trim()}' updated (now ${chars} chars).`)
      } catch (e) {
        return err(`personality_section_edit failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Scratchpad: timestamped scratch entries in one flat file.
  server.registerTool(
    'scratchpad',
    {
      title: 'Scratchpad',
      description: 'Append, read back, or clear timestamped scratch notes. Working memory across turns.',
      inputSchema: z.object({
        action: z.enum(['append', 'read', 'clear']),
        text: z.string().max(2000).optional().describe('Entry text for append'),
        limit: z.number().int().min(1).max(100).optional().describe('Entries back for read (default 20)'),
      }),
    },
    async ({ action, text, limit }: { action: 'append' | 'read' | 'clear'; text?: string; limit?: number }) => {
      try {
        if (action === 'append') {
          if (!text?.trim()) return err('append needs text')
          const { entries } = scratchAppend(text)
          return ok(`Noted (entry ${entries}).`)
        }
        if (action === 'clear') {
          const { cleared } = scratchClear()
          return ok(`Scratchpad cleared (${cleared} ${cleared === 1 ? 'entry' : 'entries'} removed).`)
        }
        const { entries, total } = scratchRead(limit ?? 20)
        return ok([`# scratchpad (${total} ${total === 1 ? 'entry' : 'entries'})`, '', ...entries].join('\n'))
      } catch (e) {
        return err(`scratchpad failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Random pick across the open work queues — something to do or revisit.
  // Uniform sample; call again to reshuffle. Read-only.
  server.registerTool(
    'random',
    {
      title: 'Random pick',
      description: 'Pick random open beads to do or revisit — uniform sample across task, stories, resume_bullets, inbox, workflows. Narrow with store, take up to 5.',
      inputSchema: z.object({
        store: z.string().optional().describe('Single store to pick from'),
        count: z.number().int().min(1).max(5).optional().describe('How many (default 1)'),
      }),
    },
    async ({ store, count }: { store?: string; count?: number }) => {
      const stores = pickStores(store?.trim() || undefined)
      if (!Array.isArray(stores)) return err(stores.error)
      const { candidates, pool } = gatherCandidates(stores)
      if (!candidates.length) return ok('# random pick\n\nNo open beads in scope — queues are clear.')
      const picks = sampleIndices(candidates.length, count ?? 1).map((i) => candidates[i])
      return ok(formatPicks(picks, pool))
    },
  )

  // Delay probe for the inbox-z55u timeout experiment: sleeps exactly
  // delay_seconds (capped), then echoes the correlation id. No shell, no
  // stores, no side effects — pure latency plus an idempotency echo so
  // late first responses are never mistaken for retry responses.
  server.registerTool(
    'timeout_probe',
    {
      title: 'Timeout probe',
      description: 'Wait delay_seconds (max 300s), then echo the correlation id with timings. For measuring when a tool call is considered stale.',
      inputSchema: z.object({
        delay_seconds: z.number().describe('Seconds to wait before responding (0-300)'),
        correlation_id: z.string().max(128).optional().describe('Caller-supplied id, echoed back; minted when omitted'),
      }),
    },
    async ({ delay_seconds, correlation_id }: { delay_seconds: number; correlation_id?: string }) => {
      const d = validateDelaySeconds(delay_seconds)
      if (!d.ok) return err(d.error)
      const c = validateCorrelationId(correlation_id)
      if (!c.ok) return err(c.error)
      const r = await runDelayProbe({ delaySeconds: d.delay, correlationId: c.id })
      return ok(formatProbeResult(r), true)
    },
  )

  server.registerTool(
    'relay_resolve_project',
    {
      title: 'Resolve project',
      description: 'Resolve natural language against foreground/backlog projects. Resolve before creating or routing work. Backlog matches are explicitly flagged. Mentioning a backlog project does not promote it.',
      inputSchema: z.object({
        text: z.string().min(1).max(500).describe('Natural-language work description'),
        limit: z.number().int().min(1).max(10).optional().describe('Max candidates (default 5)'),
      }),
    },
    async ({ text, limit }: { text: string; limit?: number }) => {
      try {
        return ok(formatResolve(await resolveProject(text, limit ?? 5)))
      } catch (e) {
        return err(`resolve failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_list_projects',
    {
      title: 'List projects',
      description: 'Inspect foreground projects or search the full backlog. Backlog hits are explicitly marked. Foreground starts empty; projects leave backlog through the promotion workflow.',
      inputSchema: z.object({
        scope: z.enum(['foreground', 'backlog', 'all']).optional().describe('Scope (default all)'),
        query: z.string().max(120).optional().describe('Title/slug search text'),
        limit: z.number().int().min(1).max(50).optional().describe('Max rows (default 20)'),
      }),
    },
    async ({ scope, query, limit }: { scope?: 'foreground' | 'backlog' | 'all'; query?: string; limit?: number }) => {
      try {
        const s = scope ?? 'all'
        return ok(formatProjectList(await listProjectsScoped(s, query, limit ?? 20), s))
      } catch (e) {
        return err(`list failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_capture',
    {
      title: 'Capture to project',
      description: 'Persist an observation, idea, friction, correction, or knowledge into the routed store with the project label. Creating a bead for a backlog project promotes it to foreground. The relay never executes work.',
      inputSchema: z.object({
        text: requiredBodyText('The observation/idea/friction/correction/knowledge'),
        kind: z.enum(['observation', 'idea', 'friction', 'correction', 'knowledge']),
        project: z.string().max(120).optional().describe('Project id, slug, or name'),
        store: z.string().max(40).optional().describe('Store override (default routes by kind)'),
      }),
    },
    async ({ text, kind, project, store }: { text: string; kind: 'observation' | 'idea' | 'friction' | 'correction' | 'knowledge'; project?: string; store?: string }) => {
      try {
        const r = await captureEntry({ text, kind, project, store })
        relayStatus.touch({ id: r.id, kind: 'task', title: text.slice(0, 120) })
        return ok([`# captured ${r.id} (STORE: ${r.store})`, ``, r.slug ? `Project: ${r.slug}${r.promoted ? ' (promoted backlog → foreground)' : ''}` : `Project: (none)`, ``, r.detail].join('\n'))
      } catch (e) {
        return err(`capture failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'project_edit',
    {
      title: 'Edit project',
      description: 'Edit an existing project bead directly — title, description, appended note, lifecycle status (active | deprecated) — without creating task or correction beads. Project resolves by id, slug, or name. Every mutation step verifies read-after-write; only report success when this call returns the receipt. Deprecating sets state:deprecated; active clears it. Backlog/foreground state is untouched (promote through capture/upsert).',
      inputSchema: z.object({
        project: z.string().min(1).max(120).describe('Project id, slug, or name'),
        title: z.string().max(200).optional().describe('New title'),
        description: bodyText('New description (empty clears it)'),
        note: bodyText('Project note to append'),
        lifecycle: z.enum(['active', 'deprecated']).optional().describe('Set deprecated (state:deprecated label) or active (clear it)'),
      }),
    },
    async ({ project, title, description, note, lifecycle }: {
      project: string; title?: string; description?: string; note?: string; lifecycle?: 'active' | 'deprecated'
    }) => {
      try {
        const r = await editProject({ project, title, description, note, lifecycle })
        relayStatus.touch({ id: r.id, kind: 'note', title: title ?? `edited project ${r.slug}` })
        return r.complete ? ok(formatProjectEdit(r)) : err(formatProjectEdit(r))
      } catch (e) {
        relayStatus.touch({ id: `project:${project}`, kind: 'failure', title: `edit project failed: ${project}`, state: 'failed' })
        return err(`project_edit failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_upsert_task',
    {
      title: 'Create or update task',
      description: 'Create a task, or update the duplicate when one already exists. Duplicate detection runs before every create. Updating a task for a backlog project promotes it to foreground.',
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe('Task title'),
        description: bodyText('Task body'),
        project: z.string().max(120).optional().describe('Project id, slug, or name'),
        labels: z.array(z.string()).max(10).optional().describe('Extra labels'),
        allow_update: z.boolean().optional().describe('Update duplicate instead of creating (default true)'),
      }),
    },
    async ({ title, description, project, labels, allow_update }: { title: string; description?: string; project?: string; labels?: string[]; allow_update?: boolean }) => {
      try {
        const r = await upsertTask({ title, description, project, labels, allowUpdate: allow_update ?? true })
        relayStatus.touch({ id: r.id, kind: 'task', title })
        return ok([`# ${r.mode} ${r.id} (STORE: task)`, ``, r.slug ? `Project: ${r.slug}${r.promoted ? ' (promoted backlog → foreground)' : ''}` : `Project: (none)`, ``, r.detail].join('\n'))
      } catch (e) {
        return err(`upsert failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_dispatch_request',
    {
      title: 'Request dispatch',
      description: 'Request external execution of a task without executing it. Writes a structured dispatch request bead for an external agent to claim. The relay never executes work itself.',
      inputSchema: z.object({
        instruction: requiredBodyText('What the external agent should do'),
        task_id: z.string().max(80).optional().describe('Existing task bead id'),
        task_title: z.string().max(200).optional().describe('Task title to attach to'),
        project: z.string().max(120).optional().describe('Project id, slug, or name'),
        target: z.string().max(200).optional().describe('Target agent or queue'),
      }),
    },
    async ({ instruction, task_id, task_title, project, target }: { instruction: string; task_id?: string; task_title?: string; project?: string; target?: string }) => {
      try {
        const r = await requestDispatch({ instruction, taskId: task_id, taskTitle: task_title, project, target })
        relayStatus.touch({ id: r.id, kind: 'dispatch', title: instruction.slice(0, 120), state: 'waiting' })
        return ok([`# dispatch requested ${r.id} (STORE: task)`, ``, r.taskRef ? `Task: ${r.taskRef}` : `Task: (none attached)`, r.slug ? `Project: ${r.slug}` : `Project: (none)`, ``, `Status: requested — not executed. An external agent must claim it.`, ``, r.detail].join('\n'))
      } catch (e) {
        return err(`dispatch failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_verify',
    {
      title: 'Verify prior work',
      description: 'Locate prior work by bead id or text and report persistence and current state, polled live from the authoritative durable stores.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe('Bead id or search text'),
        store: z.string().max(40).optional().describe('Single store to check'),
      }),
    },
    async ({ query, store }: { query: string; store?: string }) => {
      try {
        const r = await verifyWork(query, store?.trim() || undefined)
        if (r.found) for (const h of r.hits) relayStatus.markVerified(h.id, Date.now(), h.updatedAt) ?? relayStatus.touch({ id: h.id, kind: 'verify', title: h.title, state: 'done', at: h.updatedAt })
        else relayStatus.touch({ id: query.trim().slice(0, 80), kind: 'verify', title: query.trim().slice(0, 120), needsVerify: true })
        return ok(formatVerify(r.found, r.hits, r.detail))
      } catch (e) {
        return err(`verify failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_flow',
    {
      title: 'Relay flow',
      description: 'Atomic resolve → create/update-task → request-dispatch → promote flow. Steps persist coherently or the result clearly reports partial failure with what landed and what did not. Dry-run checks duplicates without writing.',
      inputSchema: z.object({
        instruction: z.string().min(1).max(2000).describe('Overall human intent for step reporting'),
        task_title: z.string().min(1).max(200).describe('Task title to create or update'),
        task_description: bodyText('Task body'),
        project_hint: z.string().max(120).optional().describe('Project id, slug, or name'),
        dispatch_instruction: bodyText('Dispatch instruction (skips dispatch when omitted)'),
        dry_run: z.boolean().optional().describe('Resolve and duplicate-check only (default false)'),
      }),
    },
    async ({ instruction, task_title, task_description, project_hint, dispatch_instruction, dry_run }: { instruction: string; task_title: string; task_description?: string; project_hint?: string; dispatch_instruction?: string; dry_run?: boolean }) => {
      try {
        const r = await runFlow({ instruction, taskTitle: task_title, taskDescription: task_description, projectHint: project_hint, dispatchInstruction: dispatch_instruction, dryRun: dry_run ?? false })
        if (r.taskId) relayStatus.touch({ id: r.taskId, kind: 'task', title: task_title })
        if (r.dispatchId) relayStatus.touch({ id: r.dispatchId, kind: 'dispatch', title: `dispatch for ${r.taskId ?? task_title}`, state: 'waiting' })
        return ok(formatFlow(r))
      } catch (e) {
        return err(`flow failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_catchup',
    {
      title: 'Relay catchup',
      description: 'Reconstruct recently-relevant work: re-reads every recently-touched bead live from the authoritative stores. Ephemeral awareness rebuilds here; stores stay authoritative. Same-turn chaining: follow the followup lines.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(8).optional().describe('Max touched items to re-read (default 8)'),
      }),
    },
    async ({ limit }: { limit?: number }) => {
      try {
        return ok(await relayCatchup(limit ?? 8))
      } catch (e) {
        return err(`catchup failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_attention_next',
    {
      title: 'Smallest next action',
      description: 'One smallest useful next action when stuck: failed writes first, then unverified touches, stale items, waiting dispatches, else the live thread. Read-only; names the exact tool call to make.',
      inputSchema: z.object({}),
    },
    async (_args: Record<string, never>) => {
      try {
        return ok(await attentionNext())
      } catch (e) {
        return err(`attention failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'relay_inspect',
    {
      title: 'Inspect Bridge source',
      description: 'Read-only self-inspection of the Beads Bridge implementation: tree, literal search, bounded single read, bounded read-many. Never modifies or executes. Chunks capped near 16KB; logs, locks, minified, and generated files are excluded.',
      inputSchema: z.object({
        action: z.enum(['tree', 'search', 'read', 'read_many']).describe('tree | search | read | read_many'),
        path: z.string().max(200).optional().describe('Repo-relative path for tree/read (default .)'),
        pattern: z.string().max(200).optional().describe('Literal search text for search'),
        paths: z.array(z.string().max(200)).max(5).optional().describe('Files for read_many (max 5)'),
        offset: z.number().int().min(1).optional().describe('First line for read (default 1)'),
        limit: z.number().int().min(1).max(300).optional().describe('Lines/entries cap'),
      }),
    },
    async ({ action, path, pattern, paths, offset, limit }: {
      action: 'tree' | 'search' | 'read' | 'read_many'; path?: string; pattern?: string;
      paths?: string[]; offset?: number; limit?: number
    }) => {
      try {
        if (action === 'tree') return ok(inspectTree(path ?? '.', 3, limit ?? 200))
        if (action === 'search') {
          if (!pattern?.trim()) return err('search needs pattern')
          return ok(inspectSearch(pattern, path ?? '.', limit ?? 30))
        }
        if (action === 'read') {
          if (!path?.trim()) return err('read needs path')
          return ok(inspectRead(path, offset ?? 1, limit ?? 120))
        }
        if (!paths?.length) return err('read_many needs paths')
        return ok(inspectReadMany(paths))
      } catch (e) {
        return err(`inspect failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  server.registerTool(
    'retrieval_search',
    {
      title: 'Federated search',
      description: 'Full-text search across all bead stores with optional store/status/label filters (same as GET /retrieval/search). Blank query lists recent beads per store.',
      inputSchema: z.object({
        query: z.string().max(500).describe('Full-text query — blank lists per-store beads'),
        stores: z.array(z.string()).max(10).optional().describe('Stores to search (default all)'),
        status: z.string().max(64).optional().describe('Status filter, e.g. open (default includes closed)'),
        labels: z.array(z.string()).max(10).optional().describe('AND labels'),
        limit: z.number().int().min(1).max(100).optional().describe('Max rows total (default 30)'),
      }),
    },
    async ({ query, stores, status, labels, limit }: {
      query: string; stores?: string[]; status?: string; labels?: string[]; limit?: number
    }) => {
      const { stores: used, unknown } = pickRetrievalStores(stores?.length ? stores : undefined)
      if (stores?.length && !used.length) return err(`unknown stores: ${(unknown.length ? unknown : stores).join(', ')} (known: ${STORES.join(', ')})`)
      const { rows, errors, stores: hit } = await federatedSearch(query, {
        stores: stores?.length ? stores : undefined,
        status: status?.slice(0, 64),
        labels: cleanLabels(labels),
        perStore: 20,
        limit: limit ?? 30,
      })
      return ok(formatSearch(query, rows, errors, hit, unknown))
    },
  )

  server.registerTool(
    'retrieval_activity',
    {
      title: 'Recent activity',
      description: 'Newest-first activity across all bead stores with limit/filters and compact change info (same as GET /retrieval/activity).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 20)'),
        stores: z.array(z.string()).max(10).optional().describe('Stores to cover (default all)'),
        status: z.string().max(64).optional().describe('Status filter (default includes closed)'),
        labels: z.array(z.string()).max(10).optional().describe('AND labels'),
        since: z.string().max(64).optional().describe('Only beads updated after this date (YYYY-MM-DD or RFC3339)'),
        history: z.boolean().optional().describe('Attach compact per-bead change info (default false)'),
      }),
    },
    async ({ limit, stores, status, labels, since, history }: {
      limit?: number; stores?: string[]; status?: string; labels?: string[]; since?: string; history?: boolean
    }) => {
      const { stores: used, unknown } = pickRetrievalStores(stores?.length ? stores : undefined)
      if (stores?.length && !used.length) return err(`unknown stores: ${(unknown.length ? unknown : stores).join(', ')} (known: ${STORES.join(', ')})`)
      const { rows, errors, stores: hit, unknownStores } = await recentActivity({
        stores: stores?.length ? stores : undefined,
        limit: clampLimit(limit, 20),
        status: status?.slice(0, 64),
        labels: cleanLabels(labels),
        since: since?.slice(0, 64),
      })
      const hist = history && rows.length ? await attachHistory(rows.slice(0, Math.min(rows.length, 20)), 2) : undefined
      return ok(formatActivity(rows, errors, hit, unknownStores, hist))
    },
  )

  server.registerTool(
    'retrieval_claimed',
    {
      title: 'Claimed beads across stores',
      description: 'Federated in_progress beads: id, title, store, claimant (@unassigned fallback), claim timestamp + age, per-row claim state (claimed|active|stale|abandoned|completed|unknown) + evidence, oldest first, each row enriched with live status/labels plus a description excerpt and optional change history — enough detail to act without a second query round. Claimed means agent hands only — never completion or freshness (same as GET /retrieval/claimed).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 20)'),
        stores: z.array(z.string()).max(10).optional().describe('Stores to cover (default all)'),
        detail: z.boolean().optional().describe('Attach bounded per-bead live detail (default true, max 20 beads)'),
        history: z.boolean().optional().describe('Attach compact per-bead change info (default false)'),
        stale_after_hours: z.number().min(1).max(720).optional().describe('Stale-after threshold in hours (default 48, the fm-ledger 2d heuristic)'),
      }),
    },
    async ({ limit, stores, detail, history, stale_after_hours }: { limit?: number; stores?: string[]; detail?: boolean; history?: boolean; stale_after_hours?: number }) => {
      const { stores: used, unknown } = pickRetrievalStores(stores?.length ? stores : undefined)
      if (stores?.length && !used.length) return err(`unknown stores: ${(unknown.length ? unknown : stores).join(', ')} (known: ${STORES.join(', ')})`)
      const staleAfterMs = staleAfterMsFromHours(stale_after_hours)
      const { rows, errors, stores: hit, unknownStores } = await claimedBeads({
        stores: stores?.length ? stores : undefined,
        limit: clampLimit(limit, 20),
        staleAfterMs,
      })
      const wantDetail = detail ?? true
      const det = wantDetail && rows.length ? await attachClaimedDetail(rows.slice(0, CLAIMED_DETAIL_MAX_BEADS)) : undefined
      const hist = history && rows.length ? await attachHistory(rows.slice(0, Math.min(rows.length, 20)), 2) : undefined
      return ok(formatClaimed(rows, errors, hit, unknownStores, det, hist, staleAfterMs))
    },
  )

  server.registerTool(
    'retrieval_snapshot',
    {
      title: 'Reconstruction snapshot',
      description: 'Bounded project/work-cluster snapshot: bead id or search phrase in; parent/child/dependency/mentioned/project relations traversed with dedupe, states and timestamps in one snapshot (same as GET /retrieval/snapshot).',
      inputSchema: z.object({
        input: z.string().min(1).max(500).describe('Bead id or search phrase (top hit becomes the root)'),
        depth: z.number().int().min(0).max(SNAPSHOT_MAX_DEPTH).optional().describe(`Traversal depth (default ${SNAPSHOT_DEFAULT_DEPTH}, max ${SNAPSHOT_MAX_DEPTH})`),
        cap: z.number().int().min(1).max(SNAPSHOT_MAX_CAP).optional().describe(`Max beads (default ${SNAPSHOT_DEFAULT_CAP}, max ${SNAPSHOT_MAX_CAP})`),
      }),
    },
    async ({ input, depth, cap }: { input: string; depth?: number; cap?: number }) => {
      const snap = await reconstructSnapshot(input, {
        depth: depth ?? SNAPSHOT_DEFAULT_DEPTH,
        cap: cap ?? SNAPSHOT_DEFAULT_CAP,
      })
      return snap.error ? err(formatSnapshot(snap)) : ok(formatSnapshot(snap))
    },
  )

  server.registerTool(
    'relay_status',
    {
      title: 'Relay status',
      description: 'Ephemeral relay-status projection: recently touched tasks, dispatches, verifications, failures, completions with their event timestamps, ages relative to this read, and state. Each row names which time it is: `at` is the event\u2019s own source timestamp, `touched` is only the bridge\u2019s touch. The response also carries a JSON timing block (readAt + per-item ISO/epoch timestamps + basis) so ages can be recomputed. Beads stores stay authoritative. Followup lines name the next read to make in the same turn when something is stale, failed, or needs verification.',
      inputSchema: z.object({
        mark_verified: z.string().optional().describe('Bead id just re-read — clears its follow-up'),
        pin: z.string().optional().describe('Bead id to pin (exempt from age-out)'),
        unpin: z.string().optional().describe('Bead id to unpin'),
      }),
    },
    async ({ mark_verified, pin, unpin }: { mark_verified?: string; pin?: string; unpin?: string }) => {
      if (mark_verified?.trim()) relayStatus.markVerified(mark_verified.trim())
      if (pin?.trim()) relayStatus.pin(pin.trim(), true)
      if (unpin?.trim()) relayStatus.pin(unpin.trim(), false)
      // A relay_status read surfaces the same projection heartbeat deltas
      // come from, so it advances the caller's cursor too (see
      // docs/heartbeat.md). Bare response: no footer, no re-trigger.
      advanceHeartbeatCursor(currentScope()?.caller ?? HEARTBEAT_CALLER_ANONYMOUS)
      const now = Date.now()
      return withTiming(formatRelayStatus(relayStatus, now), relayStatusReading(relayStatus, now), true)
    },
  )

  // Agent-mail presence (persistent-contact readout): who is this agent,
  // are they home, how deep is their unread inbox. Reads only — the pilot
  // owns delivery (send_message) and identity (register_agent). Profiles
  // are registration_token-gated by the pilot: without the token this
  // reports credentialed + handshake guidance and asserts nothing about
  // existence. Upstream is the loopback pilot (see ../lib/agent-mail.ts).
  server.registerTool(
    'agent_presence',
    {
      title: 'Agent presence check',
      description: 'Presence readout for one agent-mail agent: active/stale/retired verdict from last_active, contact policy, unread inbox depth. Needs the agent\u2019s registration_token for a full readout (shared out-of-band or via the request_contact handshake) — without it, reports credentialed without claiming existence. Read-only; sending stays on agent-mail send_message.',
      inputSchema: z.object({
        project: z.string().min(1).max(120).describe('Agent-mail project key'),
        agent: z.string().min(1).max(128).describe('Agent name (stable registered id, e.g. worker_42)'),
        registration_token: z.string().max(128).optional().describe('Target agent\u2019s registration token — full readout; omit for the gated summary'),
      }),
    },
    async ({ project, agent, registration_token }: { project: string; agent: string; registration_token?: string }) => {
      try {
        const p = await agentPresence({ project, agent, registrationToken: registration_token })
        return ok(formatPresence(p))
      } catch (e) {
        return err(`agent_presence failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  // Heartbeat as an explicitly callable tool (task-ksmy1): the same delta
  // the automatic footer carries, on demand. Bare response (loop
  // prevention); observational only — tracker read + cursor advance.
  server.registerTool(
    'heartbeat',
    {
      title: 'Heartbeat',
      description: 'Changes since your previous MCP query (the same delta the automatic response footer carries): recently touched tasks, dispatches, verifications, failures with the event timestamp AND the age against this read. Each row names which time it is: `at` is the event\u2019s own source timestamp, `touched` is only the bridge\u2019s touch (never the action\u2019s own time). The response also carries a JSON timing block (readAt + per-item ISO/epoch timestamps + basis) so a stale proof event can be told apart from a fresh one without re-parsing prose. The first call returns the current projection as a baseline; later calls return only what changed, or Feeds current. Read-only — never creates work, requests agents, or mutates beads.',
      inputSchema: z.object({}),
    },
    async (_args: Record<string, never>) => {
      const caller = currentScope()?.caller ?? HEARTBEAT_CALLER_ANONYMOUS
      const now = Date.now()
      const payload = heartbeatReading(caller, { now })
      const text = renderHeartbeatBlock(caller, { now })
      // Feed the persistent /live heartbeat surface (observational only:
      // recording never throws and never alters the response).
      try {
        recordLatestHeartbeat({ caller, origin: 'heartbeat', text, now })
      } catch {
        /* observation never fails a response */
      }
      return withTiming(text, payload, true)
    },
  )
})

// Loopback service bearer (task-y1i3e): the MCPJungle gateway calls /mcp
// from 127.0.0.1 with a static bearer, but OAuth access tokens expire
// (24h) and the gateway holds no refresh logic — so a static OAuth token
// silently 401s days later (2026-09-18 outage: bb_at_ bearer expired,
// gateway 401 from 08:05 UTC while direct ChatGPT stayed 200). The
// bridge's own service key (`toolKey`: minted once, 0600 file, never
// expires) is therefore also accepted here — but ONLY on true
// direct-loopback sockets (same socket-peer + no-forwarding-headers rule
// as the access gate's localhost bypass). Funnel-forwarded requests
// arrive on the loopback socket WITH forwarding headers, so the service
// bearer is unusable off-host: such calls fall through to the OAuth gate
// and 401. Exported for the auth regression tests (see mcp-auth.test.ts).
export function isLoopbackServiceCall(req: Request): boolean {
  const t = String(req.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!t || t !== toolKey) return false
  if (!LOOPBACK.test(socketPeer(req))) return false
  if (hasForwardMarkers(req)) return false
  return true
}

// Bearer gate: ChatGPT completes OAuth against /oauth/*, then presents the
// token here. withMcpAuth answers 401/403 with RFC 9728 challenges itself.
// Unauthenticated callers get discovery instead of tools.
const authedMcpHandler = withMcpAuth(
  mcpHandler,
  (req, bearerToken) => {
    if (!bearerToken) return undefined
    const rec = lookupAccess(bearerToken)
    if (!rec || rec.resource !== mcpResource(BASE)) return undefined
    return { token: rec.token, clientId: rec.clientId, scopes: rec.scope }
  },
  {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource/mcp',
    // Origin only: withMcpAuth appends resourceMetadataPath to build the
    // challenge URL (passing the full resource would double the /mcp path).
    resourceUrl: BASE,
  },
)

// mcp-handler speaks Fetch Request/Response; adapt at the boundary.
// Sparse 2026 envelopes (ChatGPT) are backfilled first so the SDK's
// strict envelope validation passes; everything else flows through.
// Per-query telemetry wraps the whole chain (compat backfill + handler):
// durable JSONL per request for lifecycle research, never failing responses.
// The bare chain is identical minus the OAuth gate — the loopback service
// bearer was already verified against the socket above, so withMcpAuth has
// nothing left to check (whoami on this path reports no OAuth authInfo).
const telemetryBareHandler = withTelemetry((fetchReq) => withCompatRequest(fetchReq).then((r) => mcpHandler(r)))
const telemetryMcpHandler = withTelemetry((fetchReq) => withCompatRequest(fetchReq).then((r) => authedMcpHandler(r)))

// Request scope for follow-ons (followons.ts): tool name off the envelope
// clone plus caller key off the bearer, installed around the inner chain
// so footers compose per caller with zero changes to tool callbacks. The
// bare chain is reachable only via the verified loopback service bearer
// (Express branch below), so its caller is loopback-local; the authed
// chain resolves the OAuth clientId (anonymous fallback never reaches a
// tool — withMcpAuth 401s first).
// Live activity ring (project-s1rf.1.1.2): withActivity sits INSIDE the
// follow-on scope so each event carries the canonical scoped tool/caller
// key, reusing the task-ksmy1 session/caller identity with no new model.
// Observational only — it clones the response, never alters it.
const scopedBareHandler = withFollowonScope(withActivity(telemetryBareHandler), () => HEARTBEAT_CALLER_LOOPBACK)
const scopedAuthedHandler = withFollowonScope(
  withActivity(telemetryMcpHandler),
  (bearer) => (bearer ? (lookupAccess(bearer)?.clientId ?? HEARTBEAT_CALLER_ANONYMOUS) : HEARTBEAT_CALLER_ANONYMOUS),
)

// The Express layer owns the loopback-service branch because withMcpAuth
// only sees Fetch requests (no socket peer to check loopback against):
// loopback + service bearer goes straight to the tools, everything else
// faces the OAuth gate (RFC 9728 challenges on 401, exact /mcp audience).
// A rejected loopback bearer is logged with a searchable marker — the
// gateway has no refresh logic, so a future mismatch must fail loudly in
// the bridge log, never as a mystery 401 (see docs/jungle-gateway.md).
mcpRouter.all('/mcp', async (req: Request, res: Response) => {
  const service = isLoopbackServiceCall(req)
  try {
    const out = await (service ? scopedBareHandler : scopedAuthedHandler)(toFetchRequest(req))
    if (!service && out.status === 401 && String(req.headers?.authorization ?? '').startsWith('Bearer ')) {
      if (LOOPBACK.test(socketPeer(req)) && !hasForwardMarkers(req)) {
        console.log(`${new Date().toISOString()} jungle-bearer-mismatch 401 POST /mcp — loopback bearer rejected (service-key mismatch or expired OAuth token); re-register the gateway bearer, see docs/jungle-gateway.md`)
      }
    }
    await sendFetchResponse(res, out)
  } catch {
    res.status(500).json({ error: 'handler failed' })
  }
})
