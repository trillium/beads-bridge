# Label taxonomy — how agents label beads so content stays discoverable

Owner: project-afw (bead triage pipeline). Parent: project-xat (taxonomy).

## Namespaces (prefix:value, lowercase slugs, hyphens-not-underscores)

- `project:<slug>` — canonical project key. The join key for evidence packs
  (`/fetch/{resume}/project/{slug}`). Slugs in use: `gas-town`, `gas-city`,
  `parlay`, `interceptor`, `vrms`, `booking-saas`. New slug? Keep it short,
  lowercase, hyphenated, and use it everywhere for that project.
- `resume:<id>` — scopes a bead to a resume loop. Tasks with this label appear
  in `/findings`; stories appear in `/stories`. Required on every verification
  task and story tied to a resume.
- `story:<story-id>` — bullet → supporting story link. Required on every result
  bullet derived from a story record.
- `confirmed:<hash>` — human confirmation (the gate). Agents never write this.
- `verification:<status>` — on stories: `partial`, `verified`, `unverified`.
- `source:paste` + `paste:untriaged` — inbox lifecycle. Integrator removes
  `paste:untriaged` (or closes the bead) once integrated.
- `company:<x>`, `role:<x>`, `section:<x>` — existing resume-bullet facets.
  Leave as-is.

## Per-store rules

- **stories**: `project:<slug>` + `resume:<id>` + `verification:<status>` required.
- **task (verification)**: `resume:<id>` + `project:<slug>` required.
- **resume_bullets**: `story:<story-id>` required when derived from a story;
  `project:<slug>` required (matches the bullet's subject, not the job).
- **inbox**: lands with `source:paste` + `paste:untriaged` automatically. The
  integrator discovers store/title/labels from content, creates the real
  records with the labels above, then closes the inbox bead.
- **projects**: `project:<slug>` on the canonical record so evidence packs
  resolve it. Lifecycle labels: `state:foreground` (foreground; absence =
  backlog) and `state:deprecated` (project closed/superseded; absence =
  active). Both are independent: a project can be foreground or backlog
  while deprecated or active. Promotion happens as the side effect of a
  capture/task write for the project; `state:deprecated` is set and cleared
  only through `project_edit`.

## Triage agent process

1. Per store, list beads missing required labels (e.g. stories without
   `project:`, bullets without `story:`, tasks without `resume:`).
2. For each: read content, apply the discoverable labels, or comment what's
   ambiguous and leave it for a human.
3. Never invent `confirmed:` — confirmation is human-only.
4. Never relabel to improve a resume; labels describe what the bead IS.
