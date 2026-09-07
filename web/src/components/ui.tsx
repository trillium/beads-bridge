import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Button({
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
      {...rest}
    >
      {children}
    </button>
  )
}

export function ButtonLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="mb-2 mr-2 inline-block rounded-md border border-neutral-300 px-3 py-1.5 text-sm no-underline hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      {children}
    </a>
  )
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="my-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="my-2 text-sm">{children}</p>
}
