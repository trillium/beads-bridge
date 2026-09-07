// Step 6 POC — MV3 service-worker active reader.
// Design: the BROWSER holds the ChatGPT session. We only call same-origin
// fetch() with credentials:'include' so cookies attach automatically.
// We never read document.cookie, never copy tokens, never POST to ChatGPT,
// never touch the beads-bridge server. Reads only: list + detail GETs.
//
// Protocol (from beads-bridge/protocol-map.md):
//   LIST   GET /backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false
//   DETAIL GET /backend-api/conversations/{uuid}?include_has_versions=true&num_turns=10
// Change gate: list item `update_time` STRING advances -> fetch detail.
// Completed-visible-text rule: role=assistant AND status=finished_successfully
//   AND >=1 non-empty trimmed parts[] string. (Scratch empties excluded.)
// Never use detail `update_time` for equality (drifts +10s server-side).

const LIST_URL =
  'https://chatgpt.com/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=false&is_starred=false';
const detailUrl = (id) =>
  `https://chatgpt.com/backend-api/conversations/${id}?include_has_versions=true&num_turns=10`;

const POLL_MINUTES = 0.5; // 30s — fastest reasonable alarms cadence for a POC
const MARKER_RE = /PHONE_CAPTURE_TEST_[ABC]_2026/;

async function loadState() {
  const s = await chrome.storage.local.get({
    cursors: {}, // convId -> { message_id, create_time }
    listSeen: {}, // convId -> update_time string
    detections: [], // accepted, deduped
    phoneSends: {}, // marker -> ISO time
    lastPoll: null,
    lastError: null,
    polls: 0,
  });
  return s;
}

async function saveState(patch) {
  await chrome.storage.local.set(patch);
}

// Non-empty trimmed text parts of a message node.
function visibleTextParts(msg) {
  const parts = msg?.content?.parts ?? [];
  return parts.filter((p) => typeof p === 'string' && p.trim().length > 0);
}

function isCompletedVisibleAssistant(msg) {
  return (
    msg?.author?.role === 'assistant' &&
    msg?.status === 'finished_successfully' &&
    visibleTextParts(msg).length > 0
  );
}

// Any completed message (user or visible assistant) advances the cursor.
// User markers are how phone sends are correlated; assistant visible text
// is the actionable payload. Scratch empties never advance anything.
function isCursorAdvancing(msg) {
  if (!msg || typeof msg.create_time !== 'number') return false;
  if (msg.author?.role === 'user' && msg.status === 'finished_successfully') {
    return visibleTextParts(msg).length > 0;
  }
  return isCompletedVisibleAssistant(msg);
}

function afterCursor(msg, cursor) {
  if (!cursor) return true;
  if (msg.create_time !== cursor.create_time) return msg.create_time > cursor.create_time;
  return String(msg.id) !== String(cursor.message_id);
}

async function fetchJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url.split('?')[0]}`);
  return r.json();
}

async function pollOnce(reason = 'alarm') {
  const st = await loadState();
  const pollStarted = new Date().toISOString();
  try {
    const list = await fetchJson(LIST_URL);
    const items = list?.items ?? [];
    const detections = [...st.detections];
    const seenIds = new Set(detections.map((d) => d.message_id));
    const cursors = { ...st.cursors };
    const listSeen = { ...st.listSeen };
    let dupSkipped = 0;

    for (const item of items) {
      const convId = item?.id;
      if (!convId) continue;
      const prevUpdate = listSeen[convId];
      // New conversation OR update_time string advanced -> read detail.
      if (prevUpdate !== undefined && prevUpdate === item.update_time) continue;
      listSeen[convId] = item.update_time;

      let detail;
      try {
        detail = await fetchJson(detailUrl(convId));
      } catch (e) {
        // One conv failing must not abort the whole poll.
        continue;
      }
      const msgs = Array.isArray(detail?.messages) ? detail.messages : [];
      // Order deterministically; ids immutable once finalised.
      msgs.sort((a, b) => (a.create_time - b.create_time) || String(a.id).localeCompare(String(b.id)));

      const cursor = cursors[convId] ?? null;
      for (const m of msgs) {
        if (!isCursorAdvancing(m)) continue;
        if (cursor && !afterCursor(m, cursor)) continue;
        const text = visibleTextParts(m).join('\n').slice(0, 500);
        if (seenIds.has(m.id)) {
          dupSkipped++;
          continue;
        }
        seenIds.add(m.id);
        const marker = (text.match(MARKER_RE) || [])[0] ?? null;
        const phoneAt = marker && st.phoneSends[marker] ? st.phoneSends[marker] : null;
        const capturedAt = new Date().toISOString();
        detections.push({
          marker,
          phone_send_time: phoneAt,
          captured_time: capturedAt,
          conversation_id: convId,
          message_id: m.id,
          role: m.author?.role ?? '?',
          content: text.slice(0, 300),
          event: 'list(update_time delta)+detail GET',
          latency_ms:
            phoneAt != null ? Math.round(new Date(capturedAt) - new Date(phoneAt)) : null,
          dup_count: 0, // filled by recount below
        });
        cursors[convId] = { message_id: m.id, create_time: m.create_time };
      }
      // Advance cursor even past non-advancing tails? No — cursor only tracks
      // completed visible content, per protocol map.
    }

    // Recount duplicates: same message_id appearing >1 would indicate a bug;
    // report per-row how many extra copies exist (expected 0).
    const counts = {};
    for (const d of detections) counts[d.message_id] = (counts[d.message_id] ?? 0) + 1;
    for (const d of detections) d.dup_count = counts[d.message_id] - 1;

    await saveState({
      cursors,
      listSeen,
      detections: detections.slice(-500),
      lastPoll: pollStarted,
      lastError: null,
      polls: (st.polls ?? 0) + 1,
      lastReason: reason,
      lastDupSkipped: dupSkipped,
    });
    return { ok: true, newTotal: detections.length, dupSkipped };
  } catch (e) {
    await saveState({ lastPoll: pollStarted, lastError: String(e).slice(0, 300) });
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

// Alarm lifecycle: recreate on install/startup (alarms survive restarts,
// but re-creating is idempotent and covers fresh loads).
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create('capture-poll', { periodInMinutes: POLL_MINUTES });
  await pollOnce('install');
});
chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create('capture-poll', { periodInMinutes: POLL_MINUTES });
  // Restart-recovery check: this poll MUST NOT duplicate anything, because
  // cursors persist in storage. Duplicates would show as dup_count > 0.
  await pollOnce('startup');
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'capture-poll') pollOnce('alarm');
});

// Popup/viewer drives these messages. No writes to any server anywhere.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'POLL_NOW') {
    pollOnce('manual').then(sendResponse);
    return true;
  }
  if (msg?.type === 'RECORD_PHONE_SEND' && typeof msg.marker === 'string') {
    const m = msg.marker.match(MARKER_RE);
    if (!m) {
      sendResponse({ ok: false, error: 'marker must match PHONE_CAPTURE_TEST_[ABC]_2026' });
      return false;
    }
    const at = typeof msg.at === 'string' ? msg.at : new Date().toISOString();
    loadState().then(async (st) => {
      const phoneSends = { ...st.phoneSends, [m[0]]: at };
      // Backfill latency for already-captured rows with this marker.
      const detections = st.detections.map((d) =>
        d.marker === m[0] && d.latency_ms == null
          ? { ...d, phone_send_time: at, latency_ms: Math.round(new Date(d.captured_time) - new Date(at)) }
          : d
      );
      await saveState({ phoneSends, detections });
      sendResponse({ ok: true, marker: m[0], at });
    });
    return true;
  }
  if (msg?.type === 'CLEAR_STATE') {
    saveState({ cursors: {}, listSeen: {}, detections: [], phoneSends: {}, lastError: null }).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  }
});
