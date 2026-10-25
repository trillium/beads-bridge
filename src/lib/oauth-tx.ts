// In-memory OAuth authorization transactions (a restart just makes the user
// retry). Shared by the public approval routes (src/routes/oauth.ts) and the
// tailnet approval listener (src/lib/tailnet-approval.ts).
export interface Tx {
  clientId: string
  clientName?: string
  redirectUri: string
  scope: string[]
  state: string
  challenge: string
  resource: string
  expiresAt: number
}

export const pending = new Map<string, Tx>()

export const txId = (): string =>
  `bbtx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

export function pruneTx(): void {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k)
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
