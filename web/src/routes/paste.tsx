import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/paste')({
  component: Paste,
})

interface InboxItem {
  id: string
  title: string
  open: boolean
}

async function fetchList(): Promise<InboxItem[]> {
  const r = await fetch('/paste/list')
  if (!r.ok) throw new Error(`server returned ${r.status}`)
  return r.json()
}

function Paste() {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const [result, setResult] = useState<string>('')
  const [items, setItems] = useState<InboxItem[]>([])
  const [peeks, setPeeks] = useState<Record<string, string>>({})
  const pastedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async () => {
    try {
      setItems(await fetchList())
    } catch {
      /* panel keeps stale list */
    }
  }, [])

  useEffect(() => {
    void refresh()
    boxRef.current?.focus()
  }, [refresh])

  const doSave = useCallback(
    async (value: string) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      if (saving) return
      if (!value.trim()) {
        setResult('Nothing to save — no bead was recorded. Paste text first.')
        boxRef.current?.focus()
        return
      }
      setSaving(true)
      setReady(false)
      setResult('')
      try {
        const r = await fetch('/paste', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: 'text=' + encodeURIComponent(value),
        })
        if (!r.ok) throw new Error(`server returned ${r.status}`)
        const data = await r.json()
        pastedRef.current = false
        setText('')
        setResult(
          data.duplicate ? `Duplicate — already saved as ${data.id}.` : `Saved bead ${data.id}.`,
        )
        boxRef.current?.focus()
        void refresh()
      } catch (err) {
        setResult(`Save failed — no bead was recorded. ${err}. Your text is still in the box; try again.`)
      } finally {
        setSaving(false)
      }
    },
    [refresh, saving],
  )

  const onChange = (value: string) => {
    setText(value)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pastedRef.current && value.length > 50) {
      setReady(true)
      setResult('Pasted — auto-saving…')
      timerRef.current = setTimeout(() => void doSave(value), 700)
    } else {
      setReady(false)
    }
  }

  const togglePeek = async (id: string, open: boolean) => {
    if (!open || peeks[id]) return
    try {
      const r = await fetch(`/paste/inbox/${id}`)
      if (!r.ok) throw new Error(`server returned ${r.status}`)
      const t = await r.text()
      setPeeks((p) => ({ ...p, [id]: t.slice(0, 2000) }))
    } catch (err) {
      setPeeks((p) => ({ ...p, [id]: `peek failed: ${err}` }))
    }
  }

  const openCount = items.filter((i) => i.open).length

  return (
    <div style={{ display: 'flex', gap: 24 }}>
      <div style={{ flex: 1 }}>
        <h2>Paste → bead</h2>
        <p>
          Paste the block — nothing else to fill in. The integrator tool
          discovers store, title, and labels from the content itself.
        </p>
        {saving ? (
          <p>
            <b>Saving…</b> creating your bead, one moment.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void doSave(text)
            }}
          >
            <textarea
              ref={boxRef}
              rows={20}
              cols={70}
              placeholder="paste the agent block here"
              value={text}
              autoFocus
              onPaste={() => {
                pastedRef.current = true
              }}
              onChange={(e) => onChange(e.target.value)}
              style={
                ready
                  ? { border: '3px solid #22c55e', background: '#f0fdf4' }
                  : undefined
              }
            />
            <br />
            <br />
            <button type="submit" disabled={saving}>
              Save paste
            </button>
          </form>
        )}
        {result && <p>{result}</p>}
      </div>
      <div style={{ width: 280, borderLeft: '1px solid #ccc', paddingLeft: 16 }}>
        <h3>Inbox ({openCount} open)</h3>
        {items.length === 0 && (
          <p>
            <i>empty</i>
          </p>
        )}
        {items.map((i) => (
          <details key={i.id} onToggle={(e) => void togglePeek(i.id, e.currentTarget.open)}>
            <summary>
              {i.open ? '○' : '●'} {i.id} — {i.title.slice(0, 40)}
            </summary>
            <div>
              <i>{peeks[i.id] ?? 'expanding…'}</i>
              {peeks[i.id] && <pre>{peeks[i.id]}</pre>}
            </div>
            <div>
              <a href={`/paste/inbox/${i.id}`}>open raw</a>
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}
