const BEAD_ID_RE = /([a-z][a-z0-9]+-[a-z0-9]{3,})(?:\/|\?|$)/

function hash(s) {
  let h = 5381
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0
  return h >>> 0
}

function scan() {
  if (!document.body) return
  const body = document.body.innerText
  const re = /<beads-action>([\s\S]*?)<\/beads-action>/g
  for (const m of body.matchAll(re)) {
    const raw = m[1].trim()
    const key = String(hash(raw))
    if (window.__beadsSeen && window.__beadsSeen.has(key)) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.tool || !parsed.bead_id) continue
    ;(window.__beadsSeen = window.__beadsSeen || new Set()).add(key)
    parsed.idempotency_key = parsed.idempotency_key || `page_${key}`
    chrome.storage.local.get({ pendingActions: [] }, ({ pendingActions }) => {
      pendingActions.push({ ...parsed, pageSource: true, detectedAt: Date.now() })
      chrome.storage.local.set({ pendingActions: pendingActions.slice(-5) })
    })
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'BEADS_ACTION_RESULT') return
  const text = JSON.stringify(msg.result?.body ?? msg.result, null, 2)
  insertIntoComposer(`\n\n[beads bridge]\n${text}\n`)
})

function insertIntoComposer(text) {
  const el =
    document.querySelector('textarea') ||
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector('.ProseMirror')
  if (!el) return
  if (el.tagName === 'TEXTAREA') {
    el.value = (el.value || '') + text
    el.focus()
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    const esc = text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    el.insertAdjacentHTML('beforeend', esc)
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  }
}

setInterval(scan, 2000)
scan()