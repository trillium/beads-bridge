// Small shared helpers: coercions, cache tags, bead shell-outs, link extraction.
import { execSync } from 'child_process'
import { BASE, STORES } from './config'

export const cacheTag = () => Math.random().toString(36).slice(2, 10)

// Coerce a possibly-array/object query value to a single string.
export const qstr = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined

// Express 5 types route params as string | string[]; coerce to one string.
export const pstr = (v: unknown) => (Array.isArray(v) ? (v[0] ?? '') : String(v ?? ''))

export function bd(store: string, args: string): string {
  try {
    return execSync(`${store} ${args}`, { encoding: 'utf8', timeout: 10000 }).trim()
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string }
    return err.stdout?.trim() || err.message || 'error'
  }
}

export function storeFromId(id: string): string | null {
  return STORES.find(s => id.startsWith(s + '-')) ?? null
}

// Extract http(s) URLs and bead-ids from bead text → absolute links for research.
export function extractLinks(body: string): string[] {
  const out = new Set<string>()
  const urlRe = /https?:\/\/[^\s)\]"'<>]+/g
  for (const m of body.matchAll(urlRe)) out.add(m[0])
  const idRe = /\b([a-z][a-z0-9]+-[a-z0-9]{3,})\b/g
  for (const m of body.matchAll(idRe)) {
    const id = m[1]
    if (storeFromId(id)) out.add(`${BASE}/${id}`)
  }
  out.delete(BASE)
  return [...out]
}

// Cache buster: every URL we emit carries ?cb=<page-load-ms> so downstream
// fetchers (ChatGPT) can never serve a stale cached copy. The server ignores
// it — only `fresh` and `debug` change behavior.
// Short cache-buster: 4 alphanumeric chars (upper+lower), minted once per page.
// Same role as a timestamp stamp at a fraction of the tokens.
const CB_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const shortCode = (n = 4): string => {
  let out = ''
  for (let i = 0; i < n; i++) out += CB_ALPHABET[Math.floor(Math.random() * CB_ALPHABET.length)]
  return out
}
export const withCb = (url: string, code: string): string =>
  url.includes('?') ? `${url}&cb=${code}` : `${url}?cb=${code}`
