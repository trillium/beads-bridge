import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DiagnosticReport {
  user_description: string
  failing_operation: string
  exact_response: string
  timestamp?: string
  bridge_version?: string
  backend_version?: string
  manifest_schema_metadata?: string
  recent_call_context?: string
  client_identity?: string
  reproduction_steps?: string
}

export interface ReportReceipt {
  receipt_version: 1
  report_id: string
  received_at: string
  sha256: string
}

export interface StoredReport {
  report: DiagnosticReport
  receipt: ReportReceipt
  verified: boolean
}

export function supportHatchDirectory(): string {
  return process.env.SUPPORT_HATCH_DIR || join(process.env.HOME || '.', '.local', 'share', 'beads-bridge', 'support-hatch')
}

function reportPath(dir: string, id: string): string { return join(dir, `${id}.json`) }
function receiptPath(dir: string, id: string): string { return join(dir, `${id}.receipt.json`) }

export function submitReport(report: DiagnosticReport, dir = supportHatchDirectory()): ReportReceipt {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = randomUUID()
  const bytes = Buffer.from(JSON.stringify(report), 'utf8')
  const receipt: ReportReceipt = {
    receipt_version: 1,
    report_id: id,
    received_at: new Date().toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  // Same-directory rename ensures readers see a complete file, never a partial write.
  const reportTmp = `${reportPath(dir, id)}.${randomUUID()}.tmp`
  const receiptTmp = `${receiptPath(dir, id)}.${randomUUID()}.tmp`
  try {
    writeFileSync(reportTmp, bytes, { mode: 0o600, flag: 'wx' })
    writeFileSync(receiptTmp, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' })
    renameSync(reportTmp, reportPath(dir, id))
    renameSync(receiptTmp, receiptPath(dir, id))
  } catch (error) {
    // Don't return a receipt unless both durable files were published.
    try { unlinkSync(reportTmp) } catch { /* cleanup best effort */ }
    try { unlinkSync(receiptTmp) } catch { /* cleanup best effort */ }
    try { unlinkSync(reportPath(dir, id)) } catch { /* cleanup best effort */ }
    throw error
  }
  return receipt
}

export function retrieveReport(id: string, dir = supportHatchDirectory()): StoredReport | null {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  let reportBytes: Buffer
  let receipt: ReportReceipt
  try {
    reportBytes = readFileSync(reportPath(dir, id))
    receipt = JSON.parse(readFileSync(receiptPath(dir, id), 'utf8')) as ReportReceipt
  } catch {
    return null
  }
  const digest = createHash('sha256').update(reportBytes).digest('hex')
  if (receipt.receipt_version !== 1 || receipt.report_id !== id || digest !== receipt.sha256) {
    throw new Error(`Support report ${id} failed receipt verification`)
  }
  return { report: JSON.parse(reportBytes.toString('utf8')) as DiagnosticReport, receipt, verified: true }
}
