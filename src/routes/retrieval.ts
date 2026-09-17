// Self-retrieval HTTP surface: federated search, recent activity, and
// bounded reconstruction snapshots. Read-only; same lib as the MCP tools.
import { Router } from 'express'
import type { Request, Response } from 'express'
import { wrap } from '../wrap'
import { withDebug } from './debug-state'
import { strParam, listParam } from './query/params'
import {
  attachClaimedDetail,
  attachHistory,
  CLAIMED_DETAIL_MAX_BEADS,
  claimedBeads,
  clampLimit,
  federatedSearch,
  formatActivity,
  formatClaimed,
  formatSearch,
  formatSnapshot,
  recentActivity,
  reconstructSnapshot,
  staleAfterMsFromHours,
  SNAPSHOT_DEFAULT_CAP,
  SNAPSHOT_DEFAULT_DEPTH,
  SNAPSHOT_MAX_CAP,
  SNAPSHOT_MAX_DEPTH,
} from '../lib/retrieval'

export const mountOrder = -13
export const retrievalRouter = Router()

// GET /retrieval/search?q=...&store=...&status=...&label=...&limit=...
retrievalRouter.get('/retrieval/search', async (req: Request, res: Response) => {
  const query = strParam(req.query.q) ?? strParam(req.query.query) ?? ''
  const stores = listParam(req.query.store ?? req.query.stores)
  const status = strParam(req.query.status)
  const labels = listParam(req.query.label ?? req.query.labels)
  const limit = clampLimit(req.query.limit, 30)
  try {
    const { rows, errors, stores: used, unknownStores } = await federatedSearch(query, {
      stores: stores.length ? stores : undefined,
      status,
      labels,
      perStore: 20,
      limit,
    })
    res.type('text/plain').send(wrap({
      title: `Federated search — "${query || '(all)'}" (${rows.length})`,
      noNext: true,
      body: withDebug(req, formatSearch(query, rows, errors, used, unknownStores)),
    }))
  } catch (e) {
    res.type('text/plain').status(500).send(wrap({
      title: 'Federated search failed',
      noNext: true,
      body: `# search failed: ${((e as Error)?.message ?? String(e)).slice(0, 200)}`,
    }))
  }
})

// GET /retrieval/activity?limit=...&store=...&status=...&label=...&since=...&history=1
retrievalRouter.get('/retrieval/activity', async (req: Request, res: Response) => {
  const stores = listParam(req.query.store ?? req.query.stores)
  const status = strParam(req.query.status)
  const labels = listParam(req.query.label ?? req.query.labels)
  const since = strParam(req.query.since)
  const limit = clampLimit(req.query.limit, 20)
  const wantHistory = req.query.history !== undefined
  try {
    const { rows, errors, stores: used, unknownStores } = await recentActivity({
      stores: stores.length ? stores : undefined,
      limit,
      status,
      labels,
      since,
    })
    const history = wantHistory && rows.length ? await attachHistory(rows.slice(0, Math.min(rows.length, 20)), 2) : undefined
    res.type('text/plain').send(wrap({
      title: `Recent activity (${rows.length})`,
      noNext: true,
      body: withDebug(req, formatActivity(rows, errors, used, unknownStores, history)),
    }))
  } catch (e) {
    res.type('text/plain').status(500).send(wrap({
      title: 'Recent activity failed',
      noNext: true,
      body: `# activity failed: ${((e as Error)?.message ?? String(e)).slice(0, 200)}`,
    }))
  }
})

// GET /retrieval/claimed?limit=...&store=...&detail=1&history=1&stale_after_hours=...
retrievalRouter.get('/retrieval/claimed', async (req: Request, res: Response) => {
  const stores = listParam(req.query.store ?? req.query.stores)
  const limit = clampLimit(req.query.limit, 20)
  const wantDetail = (strParam(req.query.detail) ?? '1') !== '0'
  const wantHistory = req.query.history !== undefined
  const staleAfterMs = staleAfterMsFromHours(strParam(req.query.stale_after_hours))
  try {
    const { rows, errors, stores: used, unknownStores } = await claimedBeads({
      stores: stores.length ? stores : undefined,
      limit,
      staleAfterMs,
    })
    const det = wantDetail && rows.length ? await attachClaimedDetail(rows.slice(0, CLAIMED_DETAIL_MAX_BEADS)) : undefined
    const history = wantHistory && rows.length ? await attachHistory(rows.slice(0, Math.min(rows.length, 20)), 2) : undefined
    res.type('text/plain').send(wrap({
      title: `Claimed beads (${rows.length})`,
      noNext: true,
      body: withDebug(req, formatClaimed(rows, errors, used, unknownStores, det, history, staleAfterMs)),
    }))
  } catch (e) {
    res.type('text/plain').status(500).send(wrap({
      title: 'Claimed beads failed',
      noNext: true,
      body: `# claimed failed: ${((e as Error)?.message ?? String(e)).slice(0, 200)}`,
    }))
  }
})

// GET /retrieval/snapshot?input=...&depth=...&cap=...
retrievalRouter.get('/retrieval/snapshot', async (req: Request, res: Response) => {
  const input = strParam(req.query.input) ?? strParam(req.query.id) ?? strParam(req.query.q) ?? ''
  const depthRaw = parseInt(strParam(req.query.depth) ?? '', 10)
  const capRaw = parseInt(strParam(req.query.cap) ?? '', 10)
  const depth = Number.isFinite(depthRaw)
    ? Math.min(SNAPSHOT_MAX_DEPTH, Math.max(0, depthRaw))
    : SNAPSHOT_DEFAULT_DEPTH
  const cap = Number.isFinite(capRaw)
    ? Math.min(SNAPSHOT_MAX_CAP, Math.max(1, capRaw))
    : SNAPSHOT_DEFAULT_CAP
  try {
    const snap = await reconstructSnapshot(input, { depth, cap })
    const failed = snap.error !== undefined
    res.type('text/plain').status(failed ? 404 : 200).send(wrap({
      title: failed ? 'Reconstruction snapshot — no match' : `Reconstruction snapshot — ${snap.root} (${snap.beads.length})`,
      noNext: true,
      body: withDebug(req, formatSnapshot(snap)),
      meta: failed ? {} : { id: snap.root },
    }))
  } catch (e) {
    res.type('text/plain').status(500).send(wrap({
      title: 'Reconstruction snapshot failed',
      noNext: true,
      body: `# snapshot failed: ${((e as Error)?.message ?? String(e)).slice(0, 200)}`,
    }))
  }
})
