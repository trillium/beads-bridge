import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

const KEY = 'bb-theme'

function resolve(t: Theme): boolean {
  if (t === 'system')
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  return t === 'dark'
}

export type { Theme }

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme) || 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    const dark = resolve(theme)
    document.documentElement.classList.toggle('dark', dark)
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* private mode */
    }
  }, [theme])

  // Follow OS changes while in system mode.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () =>
      document.documentElement.classList.toggle('dark', mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  return { theme, setTheme }
}
