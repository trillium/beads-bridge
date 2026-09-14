// False-success guardrail: the bridge never reports a mutation success it
// cannot prove. Every mutating operation returns a verified receipt
// (canonical id + store + operation + verification state, read back after
// write); a failed verification is an explicit error naming what is
// unverified — never a success. Route/tool handlers convert that error into
// an error response (MCP isError, GET 500), so callers only ever see success
// with proof attached.
import type { MutationReceipt } from './mutate'

export interface UnverifiedRef {
  operation: string
  id: string
  store: string
  // Tolerated so full receipts (which always carry verified) pass straight
  // in; the message only names operation/id/store.
  verified?: boolean
}

export interface Verifiable extends UnverifiedRef {
  verified: boolean
}

export function unverifiedMessage(r: UnverifiedRef): string {
  return `unverified: ${r.operation} ${r.id} (STORE: ${r.store}) did not read back after write — not reporting success; re-read ${r.id} before claiming success`
}

export function unverifiedError(r: UnverifiedRef): Error {
  return new Error(unverifiedMessage(r))
}

// Throw when the receipt is unverified; return it unchanged otherwise.
// YOLO_DECISION: lib-level throw (not a soft flag) because the relay rule is
// "never report completion unless the current-turn mutation result confirms
// it" — a soft flag still renders as success downstream.
export function requireVerified<T extends Verifiable>(r: T): T {
  if (!r.verified) throw unverifiedError(r)
  return r
}

export function isVerified(r: Verifiable): boolean {
  return r.verified
}

export function toVerifiable(operation: string, id: string, store: string, verified: boolean): Verifiable {
  return { operation, id, store, verified }
}

export type { MutationReceipt }
