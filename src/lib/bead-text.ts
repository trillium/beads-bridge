// Rendered bead text (`bd show` + `bd comments`) for many beads, with far
// fewer subprocesses than one-show-and-one-comments-per-bead.
//
// The text itself still comes from bd: it renders markdown through glamour,
// which SQL rows cannot reproduce byte-for-byte. What SQL removes is the
// per-bead overhead around it:
//   - `bd show a b c ...` renders many beads in ONE process (they come back
//     joined by a fixed separator; a part is only trusted if its header line
//     names the expected id, otherwise that chunk is re-read one id at a time);
//   - one SQL statement gives every bead's comment count, and `bd comments`
//     for a bead with zero comments is the constant `No comments on <id>`,
//     so those spawns disappear.
// Anything unexpected (SQL down, unknown id, odd output) takes the legacy
// per-bead path, which is the behavioural source of truth.
import { execStdout, beadText, mapLimit } from './exec'
import { withSqlFallback } from './sql'
import { sqlCommentCounts } from './sql-beads'

export interface BeadRef {
  id: string
  store: string
}
export interface BeadTexts {
  body: string
  comments: string
}

export const SHOW_BATCH_SIZE = 20
// `bd show a b` joins renderings with "\n" + 60 box-drawing dashes + "\n\n".
export const SHOW_SEPARATOR = `\n${'─'.repeat(60)}\n\n`

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function legacyBeadTexts(ref: BeadRef): Promise<BeadTexts> {
  const [body, comments] = await Promise.all([beadText(ref.store, ['show', ref.id]), beadText(ref.store, ['comments', ref.id])])
  return { body, comments }
}

// Split a multi-id `bd show` output back into per-id texts, or null when it
// cannot be proven to line up with `ids`.
export function splitShow(out: string, ids: string[]): string[] | null {
  const parts = out.split(SHOW_SEPARATOR).map((p) => p.trim())
  if (parts.length !== ids.length) return null
  for (let i = 0; i < ids.length; i++) {
    const first = parts[i].split('\n', 1)[0]
    if (!new RegExp(`(^|\\s)${esc(ids[i])} · `).test(first)) return null
  }
  return parts
}

async function showChunk(store: string, ids: string[]): Promise<Map<string, string>> {
  const got = new Map<string, string>()
  if (ids.length > 1) {
    try {
      const parts = splitShow(await execStdout(store, ['show', ...ids], 20000), ids)
      if (parts) ids.forEach((id, i) => got.set(id, parts[i]))
    } catch {
      /* fall through to per-id */
    }
  }
  const rest = ids.filter((id) => !got.has(id))
  await mapLimit(rest, 6, async (id) => {
    got.set(id, await beadText(store, ['show', id]))
  })
  return got
}

async function viaSql(refs: BeadRef[]): Promise<Map<string, BeadTexts>> {
  const counts = await sqlCommentCounts(refs.map((r) => r.id))
  const out = new Map<string, BeadTexts>()
  const known = refs.filter((r) => counts.has(r.id))
  const unknown = refs.filter((r) => !counts.has(r.id))

  const byStore = new Map<string, string[]>()
  for (const r of known) byStore.set(r.store, [...(byStore.get(r.store) ?? []), r.id])
  const chunks: { store: string; ids: string[] }[] = []
  for (const [store, ids] of byStore) {
    for (let i = 0; i < ids.length; i += SHOW_BATCH_SIZE) chunks.push({ store, ids: ids.slice(i, i + SHOW_BATCH_SIZE) })
  }
  const bodies = new Map<string, string>()
  await mapLimit(chunks, 6, async (c) => {
    for (const [id, text] of await showChunk(c.store, c.ids)) bodies.set(id, text)
  })
  await Promise.all([
    mapLimit(known, 12, async (r) => {
      const n = counts.get(r.id) ?? 0
      const comments = n === 0 ? `No comments on ${r.id}` : await beadText(r.store, ['comments', r.id])
      out.set(r.id, { body: bodies.get(r.id) ?? '', comments })
    }),
    mapLimit(unknown, 12, async (r) => {
      out.set(r.id, await legacyBeadTexts(r))
    }),
  ])
  return out
}

/** Texts for every ref, keyed by id. Output is identical to the legacy per-bead path. */
export async function fetchBeadTexts(refs: BeadRef[], label = 'beads_bundle'): Promise<Map<string, BeadTexts>> {
  if (!refs.length) return new Map()
  return withSqlFallback(label, () => viaSql(refs), async () => {
    const out = new Map<string, BeadTexts>()
    await mapLimit(refs, 12, async (r) => {
      out.set(r.id, await legacyBeadTexts(r))
    })
    return out
  })
}

/** The per-bead block both bundle surfaces emit. */
export function renderBeadBlock(id: string, store: string, t: BeadTexts): string {
  return [`# ${id} (STORE: ${store})`, '', t.comments ? `${t.body}\n\n## Comments\n${t.comments}` : t.body].join('\n')
}
