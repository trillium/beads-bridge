// GET /print/{resumeId} — print page setup + layout verdict for a resume.
// Separate route (not a fetch mode): paper, margins, budget, defects, and
// what to do about them. Backed by layout-check.ts on the newest snapshot PDF.
import { Router, Request, Response } from 'express'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { BASE, RESUME_DOCX_DIR } from '../config'
import { pstr, withCb, shortCode } from '../util'
import { wrap } from '../wrap'

export const printRouter = Router()
const execFileAsync = promisify(execFile)

interface LayoutReport {
  verdict: string; ok: boolean; pageCount: number; maxPages: number;
  summary: string; orphanLines: { text: string; wordCount: number }[];
  gaps: unknown[]; underfilled: unknown[]; hasEmdash: boolean;
}

async function resumeScope(id: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('python3', ['-c',
      `import json,subprocess; d=subprocess.run(["resumes","show","${id}","--json"],capture_output=True,text=True,timeout=30).stdout; ` +
      `r=json.loads(d); r=r[0] if isinstance(r,list) else r; ` +
      `print(json.loads(r.get("description") or "{}").get("restyledJson") or "")`])
    const m = stdout.trim().match(/resumes-(.+)-restyled\.json/)
    return m ? m[1] : null
  } catch { return null }
}

function newestPdf(scope: string | null): string | null {
  try {
    const pats = scope ? `Trillium_Smith_${scope}_` : 'Trillium_Smith_'
    const hits = readdirSync(RESUME_DOCX_DIR)
      .filter(f => f.startsWith(pats) && f.endsWith('.pdf'))
      .map(f => ({ f, m: statSync(join(RESUME_DOCX_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    return hits.length ? join(RESUME_DOCX_DIR, hits[0].f) : null
  } catch { return null }
}

printRouter.get('/print/:id', async (req: Request, res: Response) => {
  const id = String(pstr(req.params.id))
  if (!/^[A-Za-z][A-Za-z0-9_-]{2,64}$/.test(id)) {
    return res.type('text/plain').status(400).send(`unknown resume id: ${id}`)
  }
  const cbStamp = shortCode()
  const cb = (u: string) => withCb(u, cbStamp)
  const scope = await resumeScope(id)
  const pdf = newestPdf(scope)
  if (!pdf) return res.type('text/plain').status(404).send(`no snapshot PDF found for ${id}`)
  let rep: LayoutReport
  try {
    // layout-check exits non-zero on defects but still prints valid JSON —
    // use stdout whenever present, whatever the exit code.
    const { stdout } = await execFileAsync('bun',
      [`${RESUME_DOCX_DIR}/layout-check.ts`, pdf, '--max-pages', '1', '--json'],
      { encoding: 'utf8', timeout: 120000 }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }))
    rep = JSON.parse(stdout)
  } catch (e: unknown) {
    const err = e as Error
    return res.type('text/plain').status(502).send(`layout check failed: ${err.message ?? e}`)
  }
  const lines = [
    `# print setup — ${id}`,
    ``,
    `Paper: US Letter 8.5 x 11 in. Margins: top 0.25in, bottom 0.25in, left 0.6in, right 0.6in.`,
    `Budget: ${rep.maxPages} page. File: ${pdf.split('/').pop()}`,
    `Verdict: ${rep.ok ? 'OK — sendable' : rep.verdict + ' — do not send yet'}`,
    `Pages: ${rep.pageCount}. ${rep.summary ?? ''}`,
    ``,
  ]
  if (!rep.ok) {
    lines.push(`Defects:`)
    for (const o of rep.orphanLines ?? []) lines.push(`- orphan (${o.wordCount} words): "${o.text}" — micro-reword that bullet to pull the stub up, then rebuild + re-check`)
    if (!rep.orphanLines?.length) lines.push(`- see layout-check JSON for details: bun layout-check.ts <pdf> --json`)
    lines.push(``)
  }
  lines.push(`data last updated at ${new Date().toISOString()}`)
  res.type('text/plain').send(wrap({
    title: `Print setup — ${id}`,
    noNext: true,
    body: lines.join('\n'),
    meta: { id },
    actions: [`GET ${cb(`${BASE}/fetch/${id}/complete`)} — resume content`],
  }))
})
