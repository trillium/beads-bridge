// The bridge's config area: ~/.config/beads-bridge/. It used to live under
// ~/.config/pai/; a file that exists only at the legacy path is copied forward
// the first time it is resolved (one-line notice), so existing deployments keep
// working. Dependency-free on purpose — src/config.ts imports it at load.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = (): string => process.env.HOME ?? homedir()

export const configDir = (): string => join(home(), '.config', 'beads-bridge')
export const legacyConfigDir = (): string => join(home(), '.config', 'pai')

// Path of `name` in the config area. If only the legacy copy exists, copy it
// forward (mode kept) and log once; if the copy fails, read the legacy file.
export function configFile(name: string): string {
  const next = join(configDir(), name)
  if (existsSync(next)) return next
  const old = join(legacyConfigDir(), name)
  if (!existsSync(old)) return next
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 })
    copyFileSync(old, next)
    console.log(`[config] migrated ${old} -> ${next} (legacy ~/.config/pai path is deprecated)`)
    return next
  } catch (e) {
    console.log(`[config] using legacy ${old}; copy to ${next} failed: ${(e as Error).message}`)
    return old
  }
}

// Read-only variant for files the bridge never writes (stores.yaml): prefer the
// new path, else the legacy one, no copy.
export function configFileReadOnly(name: string): string {
  const next = join(configDir(), name)
  if (existsSync(next)) return next
  const old = join(legacyConfigDir(), name)
  return existsSync(old) ? old : next
}

