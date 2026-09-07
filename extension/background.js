const DEFAULTS = { endpoint: '__FUNNEL_BASE__', token: '' }

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS)
  return { endpoint: String(s.endpoint).replace(/\/+$/, ''), token: String(s.token || '') }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_SETTINGS' || msg?.type === 'SET_SETTINGS') {
    getSettings().then(async (s) => {
      if (msg.type === 'GET_SETTINGS') return sendResponse({ ok: true, ...s })
      const endpoint = String(msg.endpoint || s.endpoint).replace(/\/+$/, '')
      await chrome.storage.local.set({ endpoint, token: String(msg.token || '') })
      sendResponse({ ok: true, saved: true })
    })
    return true
  }

  if (msg?.type === 'BRIDGE_FETCH') {
    getSettings().then(async ({ endpoint, token }) => {
      try {
        const headers = { Authorization: `Bearer ${token}` }
        const init = { method: msg.method || 'GET', headers }
        if (msg.json) {
          headers['Content-Type'] = 'application/json'
          init.body = JSON.stringify(msg.json)
        }
        const r = await fetch(endpoint + msg.path, init)
        let body
        try {
          body = await r.json()
        } catch {
          body = await r.text()
        }
        sendResponse({ ok: true, status: r.status, body })
      } catch (e) {
        sendResponse({ ok: false, error: String(e) })
      }
    })
    return true
  }

  if (msg?.type === 'RUN_PENDING' && msg.action) {
    getSettings().then(async ({ endpoint, token }) => {
      try {
        const a = msg.action
        const r = await fetch(endpoint + `/action/${a.tool}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(a),
        })
        let body
        try {
          body = await r.json()
        } catch {
          body = await r.text()
        }
        const result = { status: r.status, body, at: Date.now() }
        await chrome.storage.local.set({ lastResult: result })
        try {
          const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] })
          for (const t of tabs) if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'BEADS_ACTION_RESULT', result })
        } catch { /* no chatgpt tab open */ }
        sendResponse({ ok: true, ...result })
      } catch (e) {
        sendResponse({ ok: false, error: String(e) })
      }
    })
    return true
  }
})

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
}