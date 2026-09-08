import { useEffect, useState } from 'react'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { Button, Note } from '../components/ui'

export const Route = createFileRoute('/resume/$resumeId')({
  component: Resume,
})

function Resume() {
  const { resumeId: resumeParam } = useParams({ from: '/resume/$resumeId' })
  const [resumeId, setResumeId] = useState(resumeParam)
  const [blurb, setBlurb] = useState('')
  const [status, setStatus] = useState('Loading…')
  const [copied, setCopied] = useState(false)

  const load = async (id: string) => {
    setStatus('Loading…')
    setBlurb('')
    try {
      // ?raw=1 forces the text blurb regardless of user-agent sniffing.
      const r = await fetch(`/resume/${id}?raw=1`, {
        headers: { Accept: 'text/plain' },
      })
      if (!r.ok) throw new Error(`server returned ${r.status}`)
      const text = await r.text()
      if (text.startsWith('<!') || text.includes('<html')) {
        throw new Error('got HTML instead of blurb — retry in a minute')
      }
      setBlurb(text)
      setStatus('')
    } catch (err) {
      setStatus(`Load failed — ${err}`)
    }
  }

  // Render the txt on arrival — no click needed. Re-loads when the URL id changes.
  useEffect(() => {
    setResumeId(resumeParam)
    void load(resumeParam)
  }, [resumeParam])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(blurb)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setStatus('Copy failed — select the text manually.')
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold">Resume working session</h1>
      <Note>Paste the block below into ChatGPT — it fetches everything itself.</Note>
      <label className="text-sm">
        Resume{' '}
        <input
          value={resumeId}
          onChange={(e) => setResumeId(e.target.value)}
          size={24}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />{' '}
        <Button onClick={() => void load(resumeId)}>Reload</Button>
      </label>
      {status && <Note>{status}</Note>}
      {blurb && (
        <>
          <p className="my-2">
            <Button onClick={() => void copy()}>{copied ? 'Copied!' : 'Copy blurb'}</Button>
          </p>
          <pre className="whitespace-pre-wrap rounded bg-neutral-100 p-4 text-sm dark:bg-neutral-900">
            {blurb}
          </pre>
        </>
      )}
    </>
  )
}
