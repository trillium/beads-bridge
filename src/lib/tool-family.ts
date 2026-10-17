// Tool → visual family for the /live event stream (task-7y3fm).
//
// One table, shared by the page (embedded as JSON, matched client-side) and
// the tests, so the family a record is drawn in can never drift from what
// the server says it is. Family colors deliberately avoid green and red:
// those two belong to the outcome pill, so action family and success/failure
// never read as the same signal.

export interface ToolFamily {
  key: string
  /** Operation-type label shown in the record's pill. */
  label: string
  /** Exact tool names. */
  tools: string[]
  /** Tool-name prefixes. */
  prefixes: string[]
}

export const TOOL_FAMILIES: ToolFamily[] = [
  {
    key: 'write',
    label: 'write',
    tools: ['bead_comment', 'bead_note', 'bead_decision', 'bead_label', 'bead_create', 'bead_batch_create', 'bead_edit', 'project_edit'],
    prefixes: [],
  },
  { key: 'feedback', label: 'feedback', tools: ['bead_feedback', 'feedback_edit'], prefixes: [] },
  { key: 'relay', label: 'relay', tools: ['agent_presence'], prefixes: ['relay_'] },
  { key: 'read', label: 'read', tools: ['bead_show', 'beads_bundle', 'query_store', 'bead_connections'], prefixes: ['retrieval_'] },
  { key: 'memory', label: 'memory', tools: ['identity_update', 'scratchpad'], prefixes: ['personality_'] },
  {
    key: 'system',
    label: 'system',
    tools: ['whoami', 'bridge_info', 'store_health', 'tool_surface_check', 'capability', 'capability_status', 'capabilities_since', 'random', 'timeout_probe', 'heartbeat'],
    prefixes: [],
  },
]

export const OTHER_FAMILY: ToolFamily = { key: 'other', label: 'other', tools: [], prefixes: [] }

export function toolFamily(tool: string): ToolFamily {
  for (const f of TOOL_FAMILIES) {
    if (f.tools.includes(tool) || f.prefixes.some((p) => tool.startsWith(p))) return f
  }
  return OTHER_FAMILY
}
