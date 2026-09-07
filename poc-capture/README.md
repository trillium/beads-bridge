# Step 6 POC — passive phone-to-desktop capture without UI interaction

Winner from Step 5: **MV3 service-worker active reader**. The browser keeps the
ChatGPT session; the worker polls with `credentials:'include'` so cookies attach
automatically. No copied cookie/token, no `document.cookie` reads, no POSTs to
ChatGPT, no beads writes.

## What it does

- Every 30s (`chrome.alarms`) + on demand (`Poll now`):
  1. `GET /backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false`
  2. For each item whose `update_time` **string** advanced (or new): `GET /backend-api/conversations/{uuid}?include_has_versions=true&num_turns=10`
  3. Scan `messages[]` with the protocol-map rule: `role=assistant` AND `status=finished_successfully` AND ≥1 non-empty trimmed part. User messages with the marker also advance the cursor.
  4. Cursor = per-conversation `(message_id, create_time)`, persisted in `chrome.storage.local`. Already-seen `message_id` never re-emits (restart-safe).
- Detail `update_time` is never used for equality (drifts server-side — see protocol map).
- List `total > limit` sliding-window noted: disappearance ≠ deletion.

## Install (unpacked, separate from the production extension)

1. `chrome://extensions` → Developer mode → Load unpacked → this `poc-capture/` dir.
2. Accept the `chatgpt.com` host permission (required for the same-origin read).
3. Keep a desktop ChatGPT tab logged in normally. **Then leave it alone.**
4. Open the extension popup (viewer) in a *separate window* so the ChatGPT tab stays untouched/backgrounded.

## Acceptance run

1. In the popup: `Clear POC state` **once**, then `Poll now` (baseline, expect 0 new).
2. Phone: send `PHONE_CAPTURE_TEST_A_2026 — what time is it, exactly?` (or any text containing the marker).
3. The instant you hit send: click `Sent A` in the popup (records `phone_send_time`).
4. Wait ≤60s. Row appears with captured time, conv/msg ids, role+snippet, event `list+detail`, latency, dup=0. Do NOT click/refresh the ChatGPT tab.
5. Repeat for B, then C with unique text.
6. Restart check: `chrome://extensions` → reload this POC (or restart Chrome) → `Poll now` → **zero new rows, all dup=0**. Cursors survived.
7. `Export JSON` → attach `capture-poc-results.json` with per-test: phone send, captured, conv_id, msg_id, role, content, event, latency, dup count.

## Pass criteria

- 3/3 markers detected exactly once, each with conv+msg ids and content.
- No interaction with the desktop ChatGPT tab during the run.
- Reload produces no duplicates.

## Known limits (from Step 5)

- 30s poll floor (alarms granularity) — latency is poll-bound, not push.
- ChatGPT API drift (params, pagination for deep convs with `num_turns=10` window).
- Logout → HTTP 401 surfaces as `lastError`; recovery = log in again, no credential handling in POC.
- This POC reads only. No watcher, no beads writes, no forgery.
