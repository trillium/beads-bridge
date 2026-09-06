const $ = (id) => document.getElementById(id)
const BEAD_ID_RE = /([a-z][a-z0-9]+-[a-z0-9]{3,})(?:\/|\?|$)/

function status(msg, kind = 'muted') {
  $('resultStatus').textContent = msg
  $('resultStatus').className = `status ${kind}`
}

function setResult(payload) {
  $('result').textContent = JSON.stringify(payload, null, 2)
}

function activeBead() {
  const manual = $('beadId').value.trim().toLowerCase()
  const re = BEAD_ID_RE
  const m = re.exec(manual)
  return m ? m[1] : (manual || '')
}

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (r) => {
  if (r?.ok) {
    $('endpoint').value = r.endpoint
    $('token').value = r.token
    $('conn').textContent = r.token ? 'authed' : 'no token'
  }
})

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const m = tab?.url ? BEAD_ID_RE.exec(tab.url) : null
  if (m) $('beadId').value = m[1]
})

chrome.storage.local.get({ pendingActions: [] }, ({ pendingActions }) => renderPending(pendingActions))
chrome.storage.local.get({ lastResult: null }, ({ lastResult }) => {
  if (lastResult) setResult(lastResult.body ?? lastResult)
})

$('saveSettings').onclick = () => {
  chrome.runtime.sendMessage(
    { type: 'SET_SETTINGS', endpoint: $('endpoint').value, token: $('token').value },
    (r) => {
      $('connStatus').textContent = r?.ok ? 'saved' : 'error'
      $('connStatus').className = `status ${r?.ok ? 'ok' : 'err'}`
      $('conn').textContent = $('token').value ? 'authed' : 'no token'
    }
  )
}

function fetchBridge(path, json) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'BRIDGE_FETCH', path, method: 'GET', json }, (r) => resolve(r))
  })
}

async function andShow(path, label) {
  const r = await fetchBridge(path)
  setResult(r?.body ?? { error: r?.error ?? 'no response' })
  if (!r?.ok) { status(`bridge call failed: ${r?.error}`, 'err'); return null }
  if (r.status >= 400) { status(`HTTP ${r.status}`, 'err'); $('result').textContent = JSON.stringify(r.body, null, 2); return null }
  status(`${label} ok — HTTP ${r.status}`, 'ok')
  const body = r.body || {}
  if (body.bead_id) $('beadId').value = body.bead_id
  return body
}

$('getNext').onclick = async () => { await andShow('/action/next', 'next') }
$('loadBead').onclick = async () => {
  const id = activeBead()
  if (!id) return status('enter a bead id', 'err')
  await andShow(`/action/bead?bead_id=${encodeURIComponent(id)}`, 'get_bead')
}

function writeAction(verb) {
  return async () => {
    const id = activeBead()
    const words = $('words').value.trim()
    if (!id) return status('enter a bead id', 'err')
    if (verb !== 'approve' && verb !== 'reject' && verb !== 'done' && verb !== 'close' && !words) {
      return status('enter words', 'err')
    }
    const json = { bead_id: id }
    if (verb === 'comment' || verb === 'note') json.text = words
    const r = await fetchBridge(`/action/${verb}`, json)
    r && setResult(r.body ?? { error: r.error })
    if (!r?.ok) return status(r?.error ?? 'bridge error', 'err')
    if (r.status >= 400) return status(`HTTP ${r.status}`, 'err')
    status(`${verb} ok`, 'ok')
    if (r.body && typeof r.body === 'object') $('beadId').value = r.body.bead_id ?? id
  }
}
$('doComment').onclick = writeAction('comment')
$('doNote').onclick = writeAction('note')
$('doApprove').onclick = writeAction('approve')
$('doReject').onclick = writeAction('reject')
$('doDone').onclick = writeAction('done')
$('doClose').onclick = writeAction('close')

let labelAdd = null
function refreshChips() {
  for (const l of ['triaged', 'ready', 'human']) {
    $(`chip-${l}`).classList.toggle('active', labelAdd === l)
  }
}
for (const l of ['triaged', 'ready', 'human']) {
  $(`chip-${l}`).onclick = () => {
    labelAdd = labelAdd === l ? null : l
    refreshChips()
  }
}
$('doLabel').onclick = async () => {
  const id = activeBead()
  if (!id) return status('enter a bead id', 'err')
  if (!labelAdd) return status('click a label chip first', 'err')
  const r = await fetchBridge('/action/label', { bead_id: id, add: labelAdd })
  r && setResult(r.body ?? { error: r.error })
  status(r?.ok && r?.status < 400 ? `label ${labelAdd} ok` : `HTTP ${r?.status ?? '?'}`, r?.ok && r?.status < 400 ? 'ok' : 'err')
}

$('copyPasteUrl').onclick = async () => {
  const id = activeBead()
  const words = $('words').value.trim() || 'PUT_YOUR_WORDS_HERE'
  if (!id) return status('enter a bead id', 'err')
  const u = `GET ${$('endpoint').value}/${id}/comment?text=${encodeURIComponent(words)}`
  await navigator.clipboard.writeText(u)
  status('paste-URL copied', 'ok')
}

$('copyResult').onclick = async () => {
  await navigator.clipboard.writeText($('result').textContent)
  status('copied', 'ok')
}

function renderPending(list) {
  $('pendingCount').textContent = list.length
  const box = $('pendingList')
  box.innerHTML = ''
  if (!list.length) { box.textContent = 'none'; return }
  for (const a of list) {
    const d = document.createElement('div')
    d.className = 'card'
    d.innerHTML =
      `<b>${a.tool}</b> ${a.bead_id}${a.text ? ' — "' + a.text.slice(0, 40) + (a.text.length > 40 ? '…' : '') + '"' : ''}` +
      `<div class="row" style="margin-top:4px">` +
      `<button class="small primary" data-run="${encodeURIComponent(JSON.stringify(a))}">run</button>` +
      `<button class="small" data-clear="${a.idempotency_key || ''}">clear</button></div>`
    box.appendChild(d)
  }
  box.querySelectorAll('[data-run]').forEach((b) => {
    b.onclick = async () => {
      const a = JSON.parse(decodeURIComponent(b.dataset.run))
      setResult({ running: a })
      status('running…', 'muted')
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'RUN_PENDING', action: a }, (r) => {
          setResult(r?.body ?? r ?? { error: r?.error ?? 'no response' })
          status(r?.ok ? `ran ${a.tool} — HTTP ${r.status}` : r?.error ?? 'failed', r?.ok ? 'ok' : 'err')
          chrome.storage.local.get({ pendingActions: [] }, ({ pendingActions }) => {
            renderPending(pendingActions.filter((x) => x.idempotency_key !== (a.idempotency_key || x.pageSource)))
          })
          resolve()
        })
      })
    }
  })
  box.querySelectorAll('[data-clear]').forEach((b) => {
    b.onclick = () => {
      chrome.storage.local.get({ pendingActions: [] }, ({ pendingActions }) => {
        renderPending(pendingActions.filter((x) => String(x.idempotency_key) !== b.dataset.clear))
        chrome.storage.local.set({ pendingActions: pendingActions.filter((x) => String(x.idempotency_key) !== b.dataset.clear) })
      })
    }
  })
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.pendingActions) renderPending(changes.pendingActions.newValue || [])
  if (changes.lastResult) setResult(changes.lastResult.newValue?.body ?? changes.lastResult.newValue)
})