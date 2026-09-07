import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { useTheme } from '../theme'
import { ThemeToggle as Toggle } from '../components/ThemeToggle'

export const Route = createRootRoute({
  component: Root,
})

function Root() {
  const { theme, setTheme } = useTheme()
  return (
    <div className="mx-auto my-8 max-w-3xl px-4">
      <nav className="mb-4 flex items-center gap-4">
        <Link to="/" className="underline">
          Home
        </Link>
        <Link to="/paste" className="underline">
          Paste
        </Link>
        <Link to="/resume/$resumeId" params={{ resumeId: 'resumes-zak' }} className="underline">
          Resume
        </Link>
        <span className="ml-auto">
          <Toggle theme={theme} setTheme={setTheme} />
        </span>
      </nav>
      <hr className="border-neutral-200 dark:border-neutral-800" />
      <Outlet />
    </div>
  )
}
