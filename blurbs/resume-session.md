---
vars:
  RESUME: string         # resume bead id, e.g. resumes-zak
  COUNT: integer         # number of page literals in URLS
  URLS: numbered-list    # fetch literals, numbered from 1
  REFRESH: numbered-list # forced-fresh re-fetch literals, numbered after URLS
  GUIDES: text           # guidance doctrine link lines
  ROSTER: text           # deeper-context bead literals + everything-at-once bundle
---
# Resume working session — {{RESUME}}

Fetch these {{COUNT}} pages EXACTLY as written below. Do not modify, shorten,
or compose these URLs — fetch each literal:

{{URLS}}

Stale check: every view ends with "data last updated at <iso>". If a stamp looks older than expected, fetch its refresh literal (same content, forced fresh):

{{REFRESH}}

Guidance doctrine for this loop (fetch any literal when you need it):

{{GUIDES}}

What they are:
- unconfirmed — pending bullets only, each with its workExperience context (frame + role + siblings). This is what needs work.
- complete — full resume markdown with a green/orange ledger plus a directions block listing the orange items.
- job-description — the posting job bead verbatim (role, duties, requirements).
- done — the exact output format to use when returning agreed changes.
- findings — open verification findings; check these FIRST before bullet work.
- stories — story records: the evidence layer beneath bullets.
- scope-refinement — project scope refinement: everything backing this resume for the job description, JD first, no labels needed. Start here for promote/demote work — resolve its stale set before bullet decisions.
- followups — mid-session refresh bank: say "query follow-up N" for live newly-resolved / newly-stale deltas.
- last-turn — previous turn: requests the last agent made plus resolves provided since.
- debug — failed fetches drop into debug themselves with a prefilled block; if a page itself won't load, go here and follow the directions.

{{DURABLE_EMIT}}

Then talk me through the orange (pending) bullets one at a time by voice.
When we agree on new wording for a bullet, output it as a markdown section
headed exactly ## {bead-id} (for example ## resume_bullets-bqk) with the new
bead text as the section body. Omit unchanged bullets entirely.

Durable statements: when producing substantial text the user is likely to
reuse, revise, copy elsewhere, or hand to another agent (session summary,
handoff, findings, report), place the finished artifact in a clearly
separated, self-contained section. Keep conversational commentary OUTSIDE
the artifact. The artifact must contain everything needed to understand and
reuse it without the surrounding conversation — context, evidence
boundaries, caveats, and instructions included. When revising an artifact,
return the complete updated artifact, not just the changes. The user saves
these sections to an inbox, so make each one paste-ready on its own.

{{ROSTER}}
