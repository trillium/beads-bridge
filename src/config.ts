// Shared config: ports, URLs, auth key, store registry. Single source of truth
// for every route module.
import { readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'

export const PORT = 3737
export const BASE = 'https://__FUNNEL_HOST__'
export const RESUME_DOCX_DIR = process.env.RESUME_DOCX_DIR ?? `${process.env.HOME}/code/resume-docx`
export const FETCH_MODES = ['unconfirmed', 'complete', 'job-description', 'done'] as const

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
