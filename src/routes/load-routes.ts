// File-based backend routing: every src/routes/*.ts that exports a *Router
// gets mounted automatically. Adding a route = adding a file.
//
// Ordering: Express matches in registration order, and verbs.ts holds
// parametric /:id/* routes that would swallow /fetch/*, /resume, /paste.
// A route file may export `mountOrder` (lower mounts first; default 0).
// Current precedence: resume-specific routes first, parametric verbs last.
import type { Express, Router } from 'express'
import { readdirSync } from 'fs'
import { join, basename } from 'path'

export async function loadRoutes(app: Express): Promise<void> {
  const dir = __dirname
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'load-routes.ts')
    .sort()
  const mounted: { file: string; order: number; routers: Router[] }[] = []
  for (const file of files) {
    const mod = await import(join(dir, basename(file, '.ts')))
    const routers = Object.entries(mod)
      .filter(([name, value]) => name.endsWith('Router') && typeof value === 'function')
      .map(([, value]) => value as Router)
    if (routers.length) {
      mounted.push({
        file,
        order: typeof mod.mountOrder === 'number' ? mod.mountOrder : 0,
        routers,
      })
    }
  }
  mounted.sort((a, b) => a.order - b.order || (a.file < b.file ? -1 : 1))
  for (const m of mounted) for (const r of m.routers) app.use(r)
}
