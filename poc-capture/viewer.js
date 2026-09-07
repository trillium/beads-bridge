const $ = (id) => document.getElementById(id);

async function refresh() {
  const st = await chrome.storage.local.get({
    detections: [], lastPoll: null, lastError: null, polls: 0,
    phoneSends: {}, lastReason: null, lastDupSkipped: 0,
  });
  $('status').textContent =
    `polls: ${st.polls}  last: ${st.lastPoll ?? '—'} (${st.lastReason ?? '—'})\n` +
    `error: ${st.lastError ?? 'none'}  dupSkipped(last poll): ${st.lastDupSkipped ?? 0}\n` +
    `detections: ${st.detections.length}  phone sends recorded: ${JSON.stringify(st.phoneSends)}`;
  $('rows').innerHTML = st.detections.map((d) => `<tr>
    <td class="mono">${d.marker ?? '—'}</td>
    <td class="mono">${d.phone_send_time ?? '—'}<br>→ ${d.captured_time}<br>${d.latency_ms != null ? (d.latency_ms / 1000).toFixed(1) + 's' : 'latency n/a'}</td>
    <td class="mono">${String(d.conversation_id).slice(0, 8)}…<br>${String(d.message_id).slice(0, 8)}…</td>
    <td><b>${d.role}</b> ${escapeHtml((d.content ?? '').slice(0, 160))}<br><span class="mono">${escapeHtml(d.event ?? '')}</span></td>
    <td class="mono">${d.dup_count ?? 0}</td>
  </tr>`).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('poll').onclick = async () => {
  $('status').textContent = 'polling…';
  await chrome.runtime.sendMessage({ type: 'POLL_NOW' });
  refresh();
};
$('export').onclick = async () => {
  const st = await chrome.storage.local.get(null);
  const blob = new Blob([JSON.stringify({
    exported_at: new Date().toISOString(),
    detections: st.detections ?? [],
    phoneSends: st.phoneSends ?? {},
    polls: st.polls ?? 0,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'capture-poc-results.json';
  a.click();
};
$('clear').onclick = async () => {
  if (!confirm('Clear POC cursors + detections? Do this ONCE before test A.')) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_STATE' });
  refresh();
};
document.querySelectorAll('[data-send]').forEach((b) => {
  b.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'RECORD_PHONE_SEND', marker: b.dataset.send, at: new Date().toISOString() });
    refresh();
  };
});

refresh();
setInterval(refresh, 5000);
