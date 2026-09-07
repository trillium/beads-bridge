import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <div style={{ fontFamily: 'system-ui', margin: '2em', maxWidth: '44em' }}>
      <nav style={{ display: 'flex', gap: '1em', marginBottom: '1em' }}>
        <Link to="/">Home</Link>
        <Link to="/paste">Paste</Link>
        <Link to="/resume" search={{ resume: 'resumes-zak' }}>Resume</Link>
      </nav>
      <hr />
      <Outlet />
    </div>
  ),
})
