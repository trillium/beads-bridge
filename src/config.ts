// Shared config: ports, URLs, auth key, store registry. Single source of truth
// for every route module.
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'

// Minimal .env loader (no dependency): KEY=value per line, # comments.
// The tailnet hostname/IP live ONLY in .env (gitignored) — never in code.
const ROOT = join(__dirname, '..')
try {
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]
    }
  }
} catch { /* no .env — env must come from the environment */ }

export const PORT = 3737
const funnel = (process.env.FUNNEL_BASE ?? '').replace(/\/$/, '')
if (!funnel) throw new Error('FUNNEL_BASE is not set (add it to .env — see .env.example)')
export const BASE = funnel
export const TAILNET_IP = process.env.TAILNET_IP ?? 'unset'
// Committed files carry __FUNNEL_BASE__ tokens; substitute at serve time.
export const fillTokens = (s: string): string => s.split('__FUNNEL_BASE__').join(BASE)
export const RESUME_DOCX_DIR = process.env.RESUME_DOCX_DIR ?? `${process.env.HOME}/code/resume-docx`
export const FETCH_MODES = ['unconfirmed', 'complete', 'job-description', 'done', 'findings', 'stories'] as const

// Tool-bridge auth: a bearer token stored outside the repo. First run mints one.
const TOOLKEY_PATH = `${process.env.HOME}/.config/pai/beads-bridge-toolkey`
export const toolKey = (() => {
  if (process.env.BEADS_BRIDGE_TOOLKEY) return process.env.BEADS_BRIDGE_TOOLKEY
  try { return readFileSync(TOOLKEY_PATH, 'utf8').trim() } catch { /* mint below */ }
  const k = `bk_${randomBytes(24).toString('base64url')}`
  writeFileSync(TOOLKEY_PATH, k, { mode: 0o600 })
  return k
})()

interface StoreEntry {
  path: string
  about?: string
}

interface StoresConfig {
  stores: Record<string, StoreEntry>
}

const storesConfig = yaml.load(
  readFileSync(`${process.env.HOME}/.config/pai/stores.yaml`, 'utf8')
) as StoresConfig

export const STORES = Object.keys(storesConfig.stores)
export const storeAbout = (store: string): string =>
  storesConfig.stores[store]?.about ?? ''
