import { useState } from 'react'
import { createFileRoute, useSearch } from '@tanstack/react-router'

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
      <h1>Resume working session</h1>
      <p>Load the blurb, copy it, switch to ChatGPT, paste it.</p>
      <label>
        Resume{' '}
        <input
          value={resumeId}
          onChange={(e) => setResumeId(e.target.value)}
          size={24}
        />{' '}
        <button type="button" onClick={() => void load()}>
          Load
        </button>
      </label>
      {status && <p>{status}</p>}
      {blurb && (
        <>
          <p>
            <button type="button" onClick={() => void copy()}>
              {copied ? 'Copied!' : 'Copy blurb'}
            </button>
          </p>
          <pre style={{ background: '#f4f4f4', padding: '1em', whiteSpace: 'pre-wrap' }}>
            {blurb}
          </pre>
        </>
      )}
    </>
  )
}
