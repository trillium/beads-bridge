import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RelayStatusTracker } from './relay-status'
import { formatCatchup, relayCatchup } from './catchup'
import { attentionNext } from './attention'

describe('formatCatchup', () => {
  it('reports clear when nothing was touched', () => {
    assert.match(formatCatchup([], []), /# catchup — clear/)
  })
  it('lists entries with live lines and followups', () => {
    const out = formatCatchup(
      [{ id: 'task-aaa', kind: 'task', title: 'Fix it', live: 'open — Fix it' }],
      [{ id: 'task-aaa', reason: 'stale — refresh if still relevant', tool: 'bead_show' }],
    )
    assert.match(out, /task-aaa/)
    assert.match(out, /followup: bead_show task-aaa/)
  })
  it('an entry with no stamp still renders its row', () => {
    const out = formatCatchup([{ id: 'task-bbb', kind: 'task', title: 'No stamp', live: 'open' }], [])
    assert.match(out, /- task-bbb \[task\] No stamp/)
    assert.doesNotMatch(out, /evidence age/, 'no stamp means no claimed age')
  })
})

describe('relayCatchup', () => {
  it('rebuilds from the tracker without touching stores when empty', async () => {
    assert.match(await relayCatchup(8, new RelayStatusTracker()), /# catchup — clear/)
  })
  it('marks non-bead ids as local markers without exec', async () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'zz9-mark', kind: 'note', title: 'scratch marker' })
    const out = await relayCatchup(8, t)
    assert.match(out, /zz9-mark/)
    assert.match(out, /local marker/)
  })
  it('states the age of each evidence row against the read (task-60f3z)', async () => {
    const read = Date.parse('2026-10-06T05:30:00.000Z')
    const t = new RelayStatusTracker()
    t.touch({ id: 'zz9-old', kind: 'note', title: 'pane proof', now: read - 12 * 60_000 })
    const out = await relayCatchup(8, t, read)
    assert.match(out, /evidence age: touched \d{4}-\d\d-\d\dT\S+ \(12 minutes ago, touch time/)
    assert.match(out, /an old touch is not proof of current work/)
  })
})

describe('attentionNext', () => {
  it('suggests the open queue when the tracker is clear', async () => {
    assert.match(await attentionNext(new RelayStatusTracker()), /query_store task/)
  })
  it('picks failed state first with a single action', async () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'zz9-ok', kind: 'task', title: 'fine' })
    t.touch({ id: 'zz9-bad', kind: 'failure', title: 'broke', state: 'failed' })
    const out = await attentionNext(t)
    assert.match(out, /# attention-next — one action/)
    assert.match(out, /zz9-bad/)
  })
  it('prefers needs-verify over active', async () => {
    const t = new RelayStatusTracker()
    t.touch({ id: 'zz9-active', kind: 'task', title: 'live thread' })
    t.touch({ id: 'zz9-unverified', kind: 'task', title: 'just wrote', needsVerify: true })
    const out = await attentionNext(t)
    assert.match(out, /zz9-unverified/)
  })
})
