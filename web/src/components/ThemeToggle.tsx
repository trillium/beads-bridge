import type { Theme } from '../theme'

export function ThemeToggle({
  theme,
  setTheme,
}: {
  theme: Theme
  setTheme: (t: Theme) => void
}) {
  const next: Theme =
    theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'
  const text =
    theme === 'light' ? '☀️ light' : theme === 'dark' ? '🌙 dark' : '🖥️ system'
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={`Theme: ${theme} (click for ${next})`}
      className="rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700"
    >
      {text}
    </button>
  )
}
