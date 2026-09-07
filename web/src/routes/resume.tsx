import { useState } from 'react'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { Button, Note } from '../components/ui'

export const Route = createFileRoute('/resume')({
  validateSearch: (search: Record<string, unknown>) => ({
    resume: typeof search.resume === 'string' ? search.resume : 'resumes-zak',
  }),
  component: Resume,
})

function Resume() {
  const { resume: resumeParam } = useSearch({ from: '/resume' })
  const [resumeId, setResumeId] = useState(resumeParam)
  const [blurb, setBlurb] = useState('')
  const [status, setStatus] = useState('')
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setStatus('Loading…')
    setBlurb('')
    try {
      const r = await fetch(`/resume/${resumeId}`, {
        headers: { Accept: 'text/plain' },
      })
      if (!r.ok) throw new Error(`server returned ${r.status}`)
      setBlurb(await r.text())
      setStatus('')
    } catch (err) {
      setStatus(`Load failed — ${err}`)
    }
  }

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
      <Note>Load the blurb, copy it, switch to ChatGPT, paste it.</Note>
      <label className="text-sm">
        Resume{' '}
        <input
          value={resumeId}
          onChange={(e) => setResumeId(e.target.value)}
          size={24}
          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
        />{' '}
        <Button onClick={() => void load()}>Load</Button>
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
