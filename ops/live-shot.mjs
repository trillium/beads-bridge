#!/usr/bin/env node
// Screenshot a /live page over CDP.
//
// Every data-bearing /live surface keeps an EventSource(/live/events) open for
// the life of the page, so the document never reaches "load complete":
// `chrome --headless --screenshot` and `--virtual-time-budget` wait forever and
// produce nothing (a human in a browser never notices; only capture is
// affected). This script therefore never waits for a load event - it navigates,
// waits a fixed settle time, and captures whatever has rendered.
//
// Usage: node ops/live-shot.mjs <url> <out.png> [settleMs] [width] [height]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [url, out, settleMsRaw, widthRaw, heightRaw] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node ops/live-shot.mjs <url> <out.png> [settleMs] [width] [height]')
  process.exit(2)
}
const settleMs = Number(settleMsRaw ?? 6000)
const width = Number(widthRaw ?? 1440)
const height = Number(heightRaw ?? 1000)

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333 + Math.floor(Math.random() * 400)
const profile = `/tmp/beads-bridge-shot-${PORT}`

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function firstPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('chrome devtools endpoint never came up')
}

let nextId = 1
function rpc(ws, method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const target = await firstPageTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

await rpc(ws, 'Page.enable')
await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
})
await rpc(ws, 'Page.navigate', { url })
await sleep(settleMs)

// Capture the whole document, not just the viewport: these pages are the
// product, and a viewport-only shot crops the roll-ups.
const { cssContentSize } = await rpc(ws, 'Page.getLayoutMetrics')
const fullHeight = Math.min(Math.ceil(cssContentSize.height), 12000)
if (fullHeight > height) {
  await rpc(ws, 'Emulation.setDeviceMetricsOverride', {
    width,
    height: fullHeight,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(500)
}
const { data } = await rpc(ws, 'Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width, height: fullHeight, scale: 1 },
})

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.from(data, 'base64'))
ws.close()
chrome.kill('SIGKILL')
console.log(`saved ${out} (${width}x${fullHeight})`)
process.exit(0)