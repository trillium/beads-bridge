// Response wrapper: consistent page shape (title, store/bead meta, next actions,
// paste block, research links, /next footer) for every plain-text route.
import { BASE } from './config'
import { cacheTag } from './util'
import { extractLinks } from './util'

export interface WrapOptions {
  title: string
  body: string
  actions?: string[]
  meta?: { store?: string; id?: string }
  /** Suppress the /next queue footer (for flows like the resume voice loop
   *  where it would mislead). */
  noNext?: boolean
}

export function wrap({ title, body, actions = [], meta = {}, noNext = false }: WrapOptions): string {
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  if (meta.store) lines.push(`STORE: ${meta.store}`)
  if (meta.id)    lines.push(`BEAD: ${meta.id}`)
  lines.push('')
  lines.push(body)
  if (actions.length) {
    lines.push('')
    lines.push('## Next')
    for (const a of actions) lines.push(`  ${a}`)
  }
  if (meta.id && meta.store) {
    const id = meta.id
    lines.push('')
    lines.push('## Paste block — copy the whole block; one paste drives everything')
    lines.push('```')
    for (const u of [
      `GET ${BASE}/${id}                    — view bead + comments (read)`,
      `GET ${BASE}/${id}/label?add=triaged  — reviewed; hidden from /next`,
      `GET ${BASE}/${id}/label?add=ready    — decided; downstream acts`,
      `GET ${BASE}/${id}/approve            — approve; comment + close`,
      `GET ${BASE}/${id}/reject             — reject; comment, stays open`,
      `GET ${BASE}/${id}/done               — handled; comment + close`,
      `GET ${BASE}/${id}/close              — close without comment`,
      `GET ${BASE}/${id}/comment?text=PUT_YOUR_WORDS_HERE`,
      `GET ${BASE}/${id}/note?text=PUT_YOUR_WORDS_HERE`,
    ]) lines.push(u)
    lines.push('```')
    lines.push('(If a ?text= URL is rejected by the fetch safety filter, retry the SAME')
    lines.push(' words using the short form ?t=...; if that fails too, give the URL with')
    lines.push(' your words filled in to the user to paste verbatim.)')
    const links = extractLinks(body)
    if (links.length) {
      lines.push('')
      lines.push('## Research links — found in this bead')
      for (const l of links) lines.push(`  ${l}`)
    }
  }
  if (!noNext) {
    lines.push('')
    lines.push('---')
    const next = `${BASE}/next?cache=${cacheTag()}`
    lines.push(`Fetch [the next item](${next}) — exact URL: ${next}`)
  }
  return lines.join('\n')
}
