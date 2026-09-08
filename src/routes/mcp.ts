// MCP endpoint (Vercel mcp-handler) over the same underlying operations
// as the GET fetcher routes — no HTTP to self. Tools call beadText/runList/bd
// directly. Mounted before readRouter's /:store catchall so /mcp isn't
// swallowed by a param route.
import { Router } from 'express'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { z } from 'zod'
import { BASE, STORES } from '../config'
import { bd, storeFromId } from '../util'
import { beadText, mapLimit } from '../lib/exec'
import { bundleIds } from './beads'
import { runList } from './query/store'
import { cleanLabel, LABEL_RE } from './query/params'
import { createBead, validateCreateLabels } from '../lib/create'
import { beadConnections, formatConnections } from '../lib/connections'
import { writeFeedback } from '../lib/feedback'
import { mountFetch } from '../lib/express-fetch'
import { lookupAccess, mcpResource } from '../lib/oauth'
import { withCompatRequest } from '../lib/mcp-compat'

export const mountOrder = -20
export const mcpRouter = Router()

const text = (t: string) => ({ type: 'text' as const, text: t })
const ok = (t: string) => ({ content: [text(t)] })
const err = (t: string) => ({ content: [text(t)], isError: true as const })

async function showBead(id: string): Promise<string> {
  const store = storeFromId(id)
  if (!store) return `unknown bead id: ${id}`
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
      if (!STORES.includes(store)) return err(`unknown store: ${store} (known: ${STORES.join(', ')})`)
      const all = (label ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10)
      const orLabels = (any ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10)
      if (!all.length && !orLabels.length && !title)
        return err('empty query — give at least one of: label, any, title')
      const { rows, error } = runList(store, all, orLabels, {
        exclude: (exclude ?? []).map(cleanLabel).filter((x): x is string => !!x).slice(0, 10),
        title: title?.slice(0, 120),
        status: status?.slice(0, 64),
        limit: limit ?? 20,
        allStates: false,
      })
      const lines = rows.map((r) => `${r.id} — ${r.title}${r.labels.length ? ` [${r.labels.join(', ')}]` : ''}`)
      return ok([`# query — ${store} (${rows.length})`, '', ...lines, ...(error ? ['', `error: ${error}`] : [])].join('\n'))
    },
  )

  // GET /{id}/comment and /{id}/note equivalents.
  server.registerTool(
    'bead_comment',
    {
      title: 'Comment on bead',
      description: 'Add a comment (same as GET /{id}/comment)',
      inputSchema: z.object({ id: z.string(), text: z.string().describe('Comment text') }),
    },
    async ({ id, text: t }: { id: string; text: string }) => {
      const store = storeFromId(id.trim())
      if (!store) return err(`unknown bead id: ${id}`)
      if (!t.trim()) return err('Missing text.')
      return ok(bd(store, `comment ${id.trim()} "${t.replace(/"/g, '\\"')}"`))
    },
  )

  server.registerTool(
    'bead_note',
    {
      title: 'Note on bead',
      description: 'Append a note (same as GET /{id}/note)',
      inputSchema: z.object({ id: z.string(), text: z.string().describe('Note text') }),
    },
    async ({ id, text: t }: { id: string; text: string }) => {
      const store = storeFromId(id.trim())
      if (!store) return err(`unknown bead id: ${id}`)
      if (!t.trim()) return err('Missing text.')
      return ok(bd(store, `note ${id.trim()} "${t.replace(/"/g, '\\"')}"`))
    },
  )

  // approve/reject/done/close equivalents (same sequences as verbs.ts).
  server.registerTool(
    'bead_decision',
    {
      title: 'Decide bead',
      description: 'approve/reject/done/close a bead (same as GET /{id}/approve etc.)',
      inputSchema: z.object({
        id: z.string(),
        decision: z.enum(['approve', 'reject', 'done', 'close']),
      }),
    },
    async ({ id, decision }: { id: string; decision: 'approve' | 'reject' | 'done' | 'close' }) => {
      const clean = id.trim()
      const store = storeFromId(clean)
      if (!store) return err(`unknown bead id: ${id}`)
      const ts = new Date().toISOString()
      if (decision === 'approve') {
        const out = bd(store, `comment ${clean} "Approved via beads-bridge ${ts}"`)
        bd(store, `close ${clean}`)
        return ok(`Approved + closed ${clean}\n${out}`)
      }
      if (decision === 'reject') {
        const out = bd(store, `comment ${clean} "Rejected via beads-bridge ${ts}"`)
        return ok(`Rejected ${clean}\n${out}`)
      }
      if (decision === 'done') {
        const out = bd(store, `comment ${clean} "Handled via beads-bridge ${ts}"`)
        bd(store, `close ${clean}`)
        return ok(`Handled + closed ${clean}\n${out}`)
      }
      return ok(`Closed ${clean}\n${bd(store, `close ${clean}`)}`)
    },
  )

  // GET /{id}/label equivalent.
  server.registerTool(
    'bead_label',
    {
      title: 'Label bead',
      description: 'Add/remove labels (same as GET /{id}/label)',
      inputSchema: z.object({
        id: z.string(),
        add: z.string().optional(),
        remove: z.string().optional(),
      }),
    },
    async ({ id, add, remove }: { id: string; add?: string; remove?: string }) => {
      const clean = id.trim()
      const store = storeFromId(clean)
      if (!store) return err(`unknown bead id: ${id}`)
      if (!add && !remove) return err('Give add and/or remove.')
      const results: string[] = []
      if (add) results.push(bd(store, `label add ${clean} ${add}`))
      if (remove) results.push(bd(store, `label remove ${clean} ${remove}`))
      return ok(results.join('\n'))
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
      description: 'Create a new bead in a store. Labels attach it: project:<slug> links to a project, resume:<id> scopes it to a resume.',
      inputSchema: z.object({
        store: z.string().describe('Store name, e.g. task, stories, brain'),
        title: z.string().min(1).max(200).describe('Bead title'),
        description: z.string().max(4000).optional().describe('Body text'),
        labels: z.array(z.string()).max(10).optional().describe('Labels, e.g. project:parlay — invalid ones are rejected'),
        parent: z.string().optional().describe('Parent bead id for hierarchy'),
      }),
    },
    async ({ store, title, description, labels, parent }: {
      store: string; title: string; description?: string; labels?: string[]; parent?: string
    }) => {
      if (!STORES.includes(store)) return err(`unknown store: ${store} (known: ${STORES.join(', ')})`)
      if (parent?.trim()) {
        const pstore = storeFromId(parent.trim())
        if (!pstore) return err(`unknown parent bead id: ${parent}`)
        if (pstore !== store) return err(`parent lives in ${pstore}, not ${store}`)
      }
      const { ok: valid, bad } = validateCreateLabels(labels)
      if (bad.length) return err(`bad label: ${bad.join(', ')} (match ${LABEL_RE}, max 64 chars)`)
      try {
        const { id, detail } = await createBead({
          store,
          title,
          description,
          labels: valid,
          parent: parent?.trim() || undefined,
        })
        return ok([`# created ${id} (STORE: ${store})`, '', `Labels: ${valid.join(', ') || '(none)'}`, '', detail].join('\n'))
      } catch (e) {
        return err(`create failed: ${e instanceof Error ? e.message : String(e)}`)
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
      const set = await beadConnections(id.trim())
      return 'error' in set ? err(set.error) : ok(formatConnections(set))
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
        text: z.string().min(1).max(4000).describe('The feedback itself'),
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
})

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
mountFetch(mcpRouter, '/mcp', (fetchReq) => withCompatRequest(fetchReq).then((r) => authedMcpHandler(r)))
