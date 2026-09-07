import { createFileRoute } from '@tanstack/react-router'
import { ButtonLink, Card } from '../components/ui'

export const Route = createFileRoute('/')({
  component: Index,
})

function Index() {
  return (
    <>
      <h1 className="text-2xl font-bold">beads-bridge</h1>
      <p className="mt-1 text-neutral-500 dark:text-neutral-400">
        Beads stores over HTTP — voice loops, paste inbox, fetch views.
      </p>

      <Card title="Resume voice loop">
        <ButtonLink href="/resume/resumes-zak">Session blurb (coder)</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/">Index</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/unconfirmed">Unconfirmed</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/complete">Complete</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/findings">Findings</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/stories">Stories</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/debug">Debug</ButtonLink>
      </Card>

      <Card title="Paste inbox">
        <p>
          Paste agent output blocks; the integrator discovers store, title, and
          labels from the content.
        </p>
      </Card>

      <Card title="Guides">
        <ButtonLink href="/guide/bullets">Bullets</ButtonLink>
        <ButtonLink href="/guide/questioning">Questioning</ButtonLink>
        <ButtonLink href="/guide/discovery">Discovery</ButtonLink>
        <ButtonLink href="/guide/labels">Labels</ButtonLink>
        <ButtonLink href="/guide/refine">Refine</ButtonLink>
      </Card>

      <Card title="Beads">
        <ButtonLink href="/next">Next item</ButtonLink>
        <ButtonLink href="/print/resumes-zak">Print (coder resume)</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/project/gas-town">Evidence: gas-town</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/project/parlay">Evidence: parlay</ButtonLink>
        <ButtonLink href="/fetch/resumes-zak/project/gas-city">Evidence: gas-city</ButtonLink>
      </Card>

      <Card title="API">
        <ButtonLink href="/help">Help</ButtonLink>
      </Card>
    </>
  )
}
