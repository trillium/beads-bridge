# Follow-ups — voice-driven mid-session refresh

## The problem
A voice-first session starts with fresh context, then the world moves:
verification completes, bullets get confirmed, new evidence lands. Re-reading
everything costs the user a copy/paste round-trip they may be doing by voice
on a phone. Follow-ups remove that round-trip.

## The idea
One bank fetch gives you ten numbered literals. Later, the user just says
"query follow-up 3" and you fetch that literal. Each follow-up recomputes
LIVE and reports what changed since the bank was issued: newly resolved,
newly stale, still stale — plus the full current lists and whole-page
refresh links. No one composes a URL, no one pastes content.

## The flow
1. Fetch the bank once (at session start, or any time you want a new baseline):
   `{BASE}/resume/{RESUME}/followups`
   The bank records a baseline: the stale id-set at that moment, with a timestamp.
2. It returns ten distinct, cache-busted literals (`/followup/1` … `/followup/10`).
3. When the user says "query follow-up 3" (or "the next follow-up"), fetch
   that literal exactly as written.
4. The follow-up answers in three parts: resolved since baseline, newly stale
   since baseline, still stale — then current unconfirmed / unverified / open
   lists, then whole-page `?fresh=1` links.

## Rules that matter
- Numbering never runs out: any N ≥ 1 works (`/followup/11`, `/followup/12`, …).
  Ten are listed because ten fits on a page, not because ten is a limit.
- Every literal is distinct and cache-busted, but content is equivalent in
  kind: each follow-up is a live recompute, never a stale reread.
- Baselines are per resume; the latest bank wins. Baselines live in server
  memory — a server restart clears them. If a follow-up says "no baseline
  recorded," re-fetch the bank.
- Deltas are membership changes (ids appearing/disappearing from the stale
  set), not content diffs. The full current lists always ride along, so
  nothing is lost by that.
- An empty follow-up ("No changes since baseline") is a valid answer —
  report it and move on, don't re-fetch hoping for more.

## Worked example
- Start: fetch `…/resume/resumes-zak/followups` → baseline: 48 stale items.
- Mid-session the user confirms three bullets elsewhere and says
  "query follow-up 2" → fetch `…/followup/2?cb=…` → "3 resolved, 0 newly
  stale, 45 still stale" plus the lists. Continue from the new state.
