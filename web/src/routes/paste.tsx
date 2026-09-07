import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button, Note } from '../components/ui'
import { InboxPanel, fetchInbox, type InboxItem } from '../components/InboxPanel'

export const Route = createFileRoute('/paste')({
  component: Paste,
})

function Paste() {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const [result, setResult] = useState('')
  const [items, setItems] = useState<InboxItem[]>([])
  const pastedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  const refresh = useCallback(async () => {
    try {
      setItems(await fetchInbox())
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
        setResult(
          `Save failed — no bead was recorded. ${err}. Your text is still in the box; try again.`,
        )
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

  return (
    <div className="flex gap-6">
      <div className="flex-1">
        <h2 className="text-xl font-semibold">Paste → bead</h2>
        <Note>
          Paste the block — nothing else to fill in. The integrator tool
          discovers store, title, and labels from the content itself.
        </Note>
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
              className={
                ready
                  ? 'rounded border-green-500 bg-green-50 outline outline-2 outline-green-500 dark:bg-green-950'
                  : 'rounded border border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900'
              }
            />
            <br />
            <br />
            <Button type="submit" disabled={saving}>
              Save paste
            </Button>
          </form>
        )}
        {result && <Note>{result}</Note>}
      </div>
      <InboxPanel items={items} />
    </div>
  )
}
