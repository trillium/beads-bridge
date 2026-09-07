// Paste routes: user pastes agent output blocks into a form (or POSTs JSON),
// each paste lands as a bead in the chosen store for later AI integration.
import { Router, Request, Response } from 'express'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { BASE } from '../config'
import { withCb, shortCode } from '../util'

export const pasteRouter = Router()

// Stores the paste form may target (CLI wrapper must exist in PATH).
const PASTE_STORES = ['inbox', 'task', 'resume_bullets', 'stories'] as const

// Exact-text dedupe: sha256(text) -> bead id, persisted as an internal cache.
// The inbox was receiving the same block multiple times; resubmits now resolve
// to the original bead instead of creating a duplicate.
const HASH_CACHE = join(homedir(), 'data', 'inbox', '.paste-hashes.json')
const loadHashes = (): Record<string, string> => {
  try { return JSON.parse(readFileSync(HASH_CACHE, 'utf8')) } catch { return {} }
}
const saveHash = (hash: string, id: string): void => {
  const cache = loadHashes()
  cache[hash] = id
  mkdirSync(dirname(HASH_CACHE), { recursive: true })
  writeFileSync(HASH_CACHE, JSON.stringify(cache, null, 1))
}
const textHash = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)

interface InboxItem { id: string; title: string; open: boolean }

async function inboxItems(): Promise<InboxItem[]> {
  try {
    const out = await run('inbox', ['list', '--json'])
    const rows = JSON.parse(out)
    const list = Array.isArray(rows) ? rows : (rows?.issues ?? rows?.rows ?? [])
    return list.map((r: any) => ({
      id: String(r.id ?? r.bead_id ?? ''),
      title: String(r.title ?? '(untitled)'),
      open: String(r.status ?? r.state ?? 'open').toLowerCase() === 'open',
    })).filter((r: InboxItem) => r.id)
  } catch { return [] }
}

const PAGE = (msg: string, items: InboxItem[]) => `<!doctype html><html><body>
<div style="display:flex;gap:24px">
<div style="flex:1">
<h2>Paste → bead</h2>
${msg ? `<p><b>${msg}</b></p>` : ``}
<p>Paste the block and submit — nothing else to fill in. The integrator tool discovers
store, title, and labels from the content itself.</p>
<div id="formwrap">
<form id="pasteform">
<textarea id="pastetext" rows="20" cols="70" placeholder="paste the agent block here" autofocus></textarea><br><br>
<button type="submit" id="savebtn">Save paste</button>
</form>
</div>
<div id="loading" style="display:none">
<p><b>Saving…</b> creating your bead, one moment.</p>
</div>
<div id="result"></div>
<script>
var box = document.getElementById('pastetext');
var btn = document.getElementById('savebtn');
var pasted = false;
var autoTimer = null;
var setReady = function (on) {
  box.style.border = on ? '3px solid #22c55e' : '';
  box.style.background = on ? '#f0fdf4' : '';
};
var cancelAuto = function () {
  pasted = false;
  setReady(false);
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
};
box.addEventListener('paste', function () { pasted = true; });
box.addEventListener('input', function () {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (pasted && box.value.length > 50) {
    setReady(true);
    document.getElementById('result').innerHTML = '<p>Pasted — auto-saving…</p>';
    autoTimer = setTimeout(function () { doSave(true); }, 700);
  } else {
    setReady(false);
  }
});
var esc = function (s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};
var itemHtml = function (i) {
  return '<details data-id="' + i.id + '"><summary>' + (i.open ? '○' : '●') + ' ' + i.id +
    ' — ' + esc(i.title.slice(0, 40)) + '</summary>' +
    '<div class="peekbody"><i>expanding…</i></div>' +
    '<div><a href="/paste/inbox/' + i.id + '">open raw</a></div></details>';
};
var renderItems = function (items) {
  var open = items.filter(function (i) { return i.open; }).length;
  document.getElementById('panel').innerHTML =
    '<h3>Inbox (' + open + ' open)</h3>' +
    (items.map(itemHtml).join('') || '<p><i>empty</i></p>');
};
// SWR peek cache: serve last-seen text instantly, revalidate behind it.
var peekCache = {};
var fillPeek = function (d, fresh) {
  var body = d.querySelector('.peekbody');
  if (body) body.innerHTML = '<pre>' + esc(String(fresh).slice(0, 2000)) + '</pre>';
};
// Lazy peek: cached text renders instantly (stale ok), fetch revalidates.
document.getElementById('panel').addEventListener('toggle', function (e) {
  var d = e.target;
  if (d.tagName !== 'DETAILS' || !d.open) return;
  var id = d.dataset.id;
  if (peekCache[id]) fillPeek(d, peekCache[id]); // stale serves now
  if (d.dataset.valid === '1') return; // fresh enough, skip revalidate
  d.dataset.valid = '1';
  fetch('/paste/inbox/' + id)
    .then(function (r) {
      if (!r.ok) throw new Error('server returned ' + r.status);
      return r.text();
    })
    .then(function (t) { peekCache[id] = t; fillPeek(d, t); })
    .catch(function (err) {
      d.dataset.valid = '';
      if (!peekCache[id]) d.querySelector('.peekbody').innerHTML = '<i>peek failed: ' + esc(String(err)) + '</i>';
    });
}, true);
var doSave = function (auto) {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (btn.disabled) return;
  if (!box.value.trim()) {
    document.getElementById('result').innerHTML = '<p><b>Nothing to save — no bead was recorded.</b> Paste text first.</p>';
    box.focus();
    return;
  }
  btn.disabled = true;
  document.getElementById('formwrap').style.display = 'none';
  document.getElementById('loading').style.display = 'block';
  fetch('/paste', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: 'text=' + encodeURIComponent(box.value)
  }).then(function (r) {
    if (!r.ok) throw new Error('server returned ' + r.status);
    return r.json();
  })
  .then(function (data) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('formwrap').style.display = 'block';
    btn.disabled = false;
    cancelAuto();
    box.value = '';
    box.focus();
    document.getElementById('result').innerHTML = data.duplicate
      ? '<p>Duplicate — already saved as <a href="/paste/inbox/' + data.id + '">' + data.id + '</a>.</p>'
      : '<p>Saved bead <a href="/paste/inbox/' + data.id + '">' + data.id + '</a>.</p>';
    fetch('/paste/list').then(function (r) { return r.json(); }).then(renderItems);
  })
  .catch(function (err) {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('formwrap').style.display = 'block';
    btn.disabled = false;
    document.getElementById('result').innerHTML = '<p><b>Save failed — no bead was recorded.</b> ' + err + '. Your text is still in the box; try again.</p>';
  });
};
document.getElementById('pasteform').addEventListener('submit', function (e) {
  e.preventDefault();
  doSave(false);
});
</script>
</div>
<div id="panel" style="width:280px;border-left:1px solid #ccc;padding-left:16px">
<h3>Inbox (${items.filter(i => i.open).length} open)</h3>
${items.map(i => `<details data-id="${i.id}"><summary>${i.open ? '○' : '●'} ${i.id} — ${i.title.slice(0, 40).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</summary><div class="peekbody"><i>expanding…</i></div><div><a href="/paste/inbox/${i.id}">open raw</a></div></details>`).join('\n') || '<p><i>empty</i></p>'}
</div>
</div>
</body></html>`

// Title is derived, never asked: first non-empty line, truncated.
const deriveTitle = (text: string): string => {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const clean = line.replace(/^#+\s*/, '').slice(0, 80)
  return clean || `pasted block ${new Date().toISOString().slice(0, 10)}`
}

const run = (store: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(store, args, { timeout: 30000 }, (e, so, se) =>
      e ? reject(new Error(String(se || e.message))) : resolve(so)))

pasteRouter.get('/paste', async (_req: Request, res: Response) => {
  res.type('html').send(PAGE('', await inboxItems()))
})

pasteRouter.post('/paste', async (req: Request, res: Response) => {
  try {
    // Store is fixed: everything lands in inbox untriaged. The integrator
    // discovers target store, title, and labels from the content itself.
    const store = 'inbox'
    const text = String(req.body?.text ?? '')
    if (!text.trim()) return void res.type('html').send(PAGE('nothing to save — paste text first', await inboxItems()))
    const hash = textHash(text)
    const seen = loadHashes()[hash]
    if (seen) {
      const msg = `duplicate — exact same text already saved as <a href="/paste/inbox/${seen}">${seen}</a>; not saved again`
      if ((req.headers.accept ?? '').includes('application/json'))
        return void res.json({ id: seen, store, url: `${BASE}/paste/inbox/${seen}`, duplicate: true })
      return void res.type('html').send(PAGE(msg, await inboxItems()))
    }
    const title = String(req.body?.title ?? '').trim().slice(0, 120) || deriveTitle(text)
    const args = ['create', title, '--description', text, '--label', 'source:paste', '--label', 'paste:untriaged']
    const out = await run(store, args)
    const id = (out.match(/([a-z_]+-[a-z0-9]+)/) || [])[1] ?? 'unknown'
    if (id !== 'unknown') saveHash(hash, id)
    if ((req.headers.accept ?? '').includes('application/json'))
      return void res.json({ id, store, url: `${BASE}/paste/${store}/${id}` })
    res.type('html').send(PAGE(`saved bead <a href="/paste/${store}/${id}">${id}</a>`, await inboxItems()))
  } catch (e) {
    res.status(500).type('text').send(`paste failed: ${(e as Error).message}`)
  }
})

// JSON inbox list for live panel refresh.
pasteRouter.get('/paste/list', async (_req: Request, res: Response) => {
  res.json(await inboxItems())
})

// Raw bead text for the integrator agent.
pasteRouter.get('/paste/:store/:id', async (req: Request, res: Response) => {
  try {
    const store = String(req.params.store); const id = String(req.params.id)
    if (!PASTE_STORES.includes(store as typeof PASTE_STORES[number]))
      return void res.status(404).type('text').send('unknown store')
    res.type('text').send(await run(store, ['show', id]))
  } catch (e) {
    res.status(500).type('text').send(`retrieve failed: ${(e as Error).message}`)
  }
})

export const pasteUrl = () => withCb(`${BASE}/paste`, shortCode())
