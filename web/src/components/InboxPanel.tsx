import { useState } from 'react'

export interface InboxItem {
  id: string
  title: string
  open: boolean
}

export async function fetchInbox(): Promise<InboxItem[]> {
  const r = await fetch('/paste/list')
  if (!r.ok) throw new Error(`server returned ${r.status}`)
  return r.json()
}

function Peek({ id, title, open }: InboxItem) {
  const [text, setText] = useState<string | null>(null)
  return (
    <details
      onToggle={async (e) => {
        if (!e.currentTarget.open || text !== null) return
        try {
          const r = await fetch(`/paste/inbox/${id}`)
          if (!r.ok) throw new Error(`server returned ${r.status}`)
          setText((await r.text()).slice(0, 2000))
        } catch (err) {
          setText(`peek failed: ${err}`)
        }
      }}
    >
      <summary className="cursor-pointer">
        {open ? '○' : '●'} {id} — {title.slice(0, 40)}
      </summary>
      <div className="my-1">
        {text === null ? (
          <i>expanding…</i>
        ) : (
          <pre className="overflow-x-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900">
            {text}
          </pre>
        )}
      </div>
      <div className="text-xs">
        <a className="underline" href={`/paste/inbox/${id}`}>
          open raw
        </a>
      </div>
    </details>
  )
}

export function InboxPanel({ items }: { items: InboxItem[] }) {
  const openCount = items.filter((i) => i.open).length
  return (
    <div className="w-70 border-l border-neutral-200 pl-4 dark:border-neutral-800">
      <h3 className="font-semibold">Inbox ({openCount} open)</h3>
      {items.length === 0 && (
        <p>
          <i>empty</i>
        </p>
      )}
      {items.map((i) => (
        <Peek key={i.id} {...i} />
      ))}
    </div>
  )
}
