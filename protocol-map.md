# ChatGPT web protocol map — observed 2026-09-06 (free-tier account, chatgpt.com)

Observation instrument: Interceptor passive net capture on a dedicated background tab,
correlated with phone-originated marker messages. **No credentials were extracted or
recorded; no requests were forged or replayed; nothing below is reusable without the
browser's own session.** All headers are reported as names only (the passive log does
not surface header values — `requestHeaders` is `{}` on every entry).

## Endpoints (conversation family)

| Endpoint | Method | Purpose | Seen query params |
|---|---|---|---|
| `/backend-api/conversations` | GET | Recents list (metadata only) | `offset=0&limit=28&order=updated&is_archived=false&is_starred=false` |
| `/backend-api/conversations/{uuid}` | GET | Full conversation (windowed tail) | `include_has_versions=true&num_turns=10` |
| `/backend-api/conversation/init` | GET | Feature flags | none |
| `/backend-api/conversation/{uuid}/textdocs` | GET | Document attachments (`[]`) | none |
| `/backend-api/bazaar/conversation/{uuid}/ads` | GET | Ads (`{conversation_id, entries_by_turn_id}`) | none |
| `/backend-api/conversation/{uuid}` | GET | Unseen variant, NOT observed | — |
| `/backend-api/sentinel/chat-requirements/prepare` `…/finalize` | GET | Write-path anti-abuse tokens | — |
| `/backend-api/f/conversation/prepare` | GET | Write-prep `{status, conduit_token}` | — |

Everything else observed on page load (me, settings/*, gizmos/bootstrap, models,
memories, tasks, system_hints, ces/v1/*, v1/obi, bazaar/event, amphora/notifications,
calpico, celsius/ws/user, checkout_pricing_config, pins, prompt_library, …) is
account/homepage bootstrap or telemetry — **none of it carries conversation content**
or new-message synchronization.

## Responses

**List** — `{items, total, limit, offset}`.
Item keys: `id, title, create_time, update_time, latest_assistant_turn_created_at,
pinned_time, mapping, current_node, snippet, is_archived, is_starred, …`
- Times are **ISO-8601 strings** (e.g. `2026-09-06T03:30:59.245363Z`).
- `mapping: null`, `snippet: null` — **no message content in the list**.
- `latest_assistant_turn_created_at` was `null` on every observed item, including a
  conversation with a just-completed assistant reply → **not usable**.
- `total(29) > limit(28)` → the list is a **sliding window**: when a new conversation
  enters the top-28, an older one silently disappears (observed `GONE`). Do not treat
  list history as stable.

**Detail** — top-level keys: `title, create_time, update_time, moderation_results,
plugin_ids, conversation_id, gizmo_type, default_model_slug, atlas_mode_enabled,
conversation_origin, is_read_only, voice, async_status, is_temporary_chat,
memory_scope, context_scopes, is_study_mode, owner, messages, current_node,
page_info, context_truncation_continuation, …`
- `update_time` is an **epoch float and drifts server-side** (observed +10 s vs the
  same row's list `update_time`, with no message change in between). Do **not** use
  detail `update_time` for equality/change detection.
- `messages[]` entry: `{id, author{role,name,metadata}, create_time, update_time,
  content{content_type:"text", parts[]}, status, end_turn, weight,
  metadata{request_id, turn_exchange_id, working_turn_id, …}, recipient, channel}`
  - `create_time` epoch float; weights: user=1, system=0, assistant=1.
- `page_info`: `{start_cursor, end_cursor, has_previous_page, has_next_page}`
  (cursors are message ids; both flags observed `false` on short convs — pagination
  for deep conversations unobserved).

## Assistant-reply anatomy (important)

A single phone-message reply arrives as a **chain of ≥8 internal messages** (obs. 10
for one reply):
1. user message (`finished_successfully`, non-empty parts)
2. several assistant **scratch** messages (`finished_successfully`, `parts:[""]`)
3. one assistant **genui control** message (`finished_partial_completion`,
   part begins with the genui control rune) — mid-stream marker
4. **final visible assistant text** (`finished_successfully`, non-empty parts)

⇒ **"Completed assistant response" = `role=assistant` AND `status="finished_successfully"`
AND at least one non-empty whitespace-trimmed `parts[]` string.** Neither status alone
(scratch messages also finish `finished_successfully`) nor "last message" (may be
scratch/tool) is sufficient.

## Synchronization behavior

- Phone → account is server-side: a new conversation row appeared in the list with a
  fresh `update_time` ~0.5 s after the final assistant message's `create_time`, with
  **no desktop action required** (watch tab idle in background).
- **No WebSocket/SSE**: `sse streams` empty, `page-comm` disabled, zero events. The
  desktop SPA refreshes the list **only on user interaction** (landing, focus,
  conversation switch). 45 s idle → 0 list calls; a phone message while the tab is
  idle/backgrounded produces **no** spontaneous request.
- Retrieval after idle: navigating the tab to the conversation re-triggers
  `GET /backend-api/conversations/{id}` → fresh 200 with the full new chain. The read
  path is available regardless of UI state.

## Auth / anti-forgery (names only, inferred)

- Reads are same-origin cookie-authed GETs (`chatgpt.com` → `backend-api`). Direct
  header inspection was impossible (passive log `requestHeaders:{}`).
- The client additionally holds a JWT-style `accessToken` obtainable at
  `GET /api/auth/session` (used by an earlier experiment's poller). Whether
  `backend-api` GETs require it is **unverified**; a cookie must be present regardless.
- Write path gates: `/sentinel/chat-requirements/prepare` → `{persona, prepare_token,
  turnstile, proofofwork, so}`, `/finalize`, and `/f/conversation/prepare` →
  `{status, conduit_token}`. These were observed on the **submission** path only; no
  anti-forgery value was observed as required for the read GETs.

## Identifier & cursor guidance

- Conversation: `uuid` (`id` in list & detail `conversation_id`); mutable `title`.
- Message: `uuid` (`id`); ordering = `create_time` asc, tie-break `id`.
- Stable cursor = per-conversation `(message_id, create_time)` of the last processed
  *visible* assistant text (or last completed message of any role — user tokens & empty
  assistant scaffolds advance the cursor too). Message ids/times are immutable once
  finalised; `update_time` is a change *hint* only.
- Change detection: poll list; when an item's `update_time` string advances, fetch its
  detail; scan `messages[]`; ignore anything ≤ cursor; require the
  visible-text+finished rule above before treating a reply as actionable.

## What would "remove Interceptor" require (design note, not authorized here)

The data path is plain HTTP against `chatgpt.com/backend-api`. Replacing the
browser-navigation-trigger with a real HTTP client needs: (1) the account session
(cookie and/or `accessToken`) — **not to be extracted or replayed without explicit
approval**; (2) a decision on whether read GETs need device/sentinel headers
(unverified); (3) mirroring of the observed query params. Until then, the watcher must
ride the browser's own requests via Interceptor.