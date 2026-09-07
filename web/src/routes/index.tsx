import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Index,
})

const btn: React.CSSProperties = {
  display: 'inline-block',
  margin: '.2em .4em .2em 0',
  padding: '.4em .9em',
  border: '1px solid #888',
  borderRadius: 6,
  textDecoration: 'none',
  color: '#111',
}

function Index() {
  return (
    <>
      <h1>beads-bridge</h1>
      <p style={{ color: '#555' }}>Beads stores over HTTP — voice loops, paste inbox, fetch views.</p>

      <h2>Resume voice loop</h2>
      <a style={btn} href="/resume/resumes-zak">Session blurb (coder)</a>
      <a style={btn} href="/fetch/resumes-zak/">Index</a>
      <a style={btn} href="/fetch/resumes-zak/unconfirmed">Unconfirmed</a>
      <a style={btn} href="/fetch/resumes-zak/complete">Complete</a>
      <a style={btn} href="/fetch/resumes-zak/findings">Findings</a>
      <a style={btn} href="/fetch/resumes-zak/stories">Stories</a>
      <a style={btn} href="/fetch/resumes-zak/debug">Debug</a>

      <h2>Paste inbox</h2>
      <p>
        Paste agent output blocks; the integrator discovers store, title, and
        labels from the content.
      </p>

      <h2>Guides</h2>
      <a style={btn} href="/guide/bullets">Bullets</a>
      <a style={btn} href="/guide/questioning">Questioning</a>
      <a style={btn} href="/guide/discovery">Discovery</a>
      <a style={btn} href="/guide/labels">Labels</a>
      <a style={btn} href="/guide/refine">Refine</a>

      <h2>Beads</h2>
      <a style={btn} href="/next">Next item</a>
      <a style={btn} href="/print/resumes-zak">Print (coder resume)</a>
      <a style={btn} href="/fetch/resumes-zak/project/gas-town">Evidence: gas-town</a>
      <a style={btn} href="/fetch/resumes-zak/project/parlay">Evidence: parlay</a>
      <a style={btn} href="/fetch/resumes-zak/project/gas-city">Evidence: gas-city</a>

      <h2>API</h2>
      <a style={btn} href="/help">Help</a>
    </>
  )
}
