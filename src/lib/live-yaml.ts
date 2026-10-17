// Client-side YAML-style rendering + raw JSONL helpers for the /live event
// stream. Kept as a plain-JS source string so the page inlines it (no new
// route, vps01 allowlist unchanged) and tests can evaluate the exact same
// code. ES5 only; no backticks or dollar-brace sequences (String.raw).
//
// Inputs are events the server already redacted (src/lib/redact.ts runs
// before args/summary are recorded), so rendered and raw views show the same
// redacted data. Storage and wire format stay JSONL; this only draws it.

export const LIVE_YAML_LONG = 280

export const LIVE_YAML_JS = String.raw`
var YAML_LONG = ${LIVE_YAML_LONG};
function yEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ySpan(cls, text) { return '<span class="' + cls + '">' + yEsc(text) + '</span>'; }
function yKey(k) { return ySpan('y-k', /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k)); }
// A string longer than YAML_LONG shows its head and an explicit "+N chars"
// control; yExpanded[id] = true shows it all. Never a silent cut.
function yStr(s, id, ctx) {
  var long = s.length > YAML_LONG && !(ctx.expanded && ctx.expanded[id]);
  var shown = long ? s.slice(0, YAML_LONG) : s;
  var h = ySpan('y-s', JSON.stringify(shown));
  if (long) {
    h += ' <button type="button" class="y-more" data-expand="' + yEsc(id) + '">… +' + (s.length - YAML_LONG) + ' chars</button>';
  } else if (s.length > YAML_LONG) {
    h += ' <button type="button" class="y-more" data-collapse="' + yEsc(id) + '">collapse</button>';
  }
  return h;
}
function yScalar(v, id, ctx) {
  if (v === null || v === undefined) return ySpan('y-null', 'null');
  if (typeof v === 'boolean') return ySpan('y-b', String(v));
  if (typeof v === 'number') return ySpan('y-n', String(v));
  return yStr(String(v), id, ctx);
}
function yIsCont(v) { return v !== null && typeof v === 'object'; }
function yEmpty(v) { return Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0; }
// Returns an array of HTML lines (already indented with spaces).
function yLines(v, indent, id, ctx) {
  var pad = new Array(indent + 1).join(' ');
  var out = [], i, k, keys, child, cid;
  if (Array.isArray(v)) {
    for (i = 0; i < v.length; i++) {
      child = v[i]; cid = id + '[' + i + ']';
      if (yIsCont(child) && !yEmpty(child)) {
        var sub = yLines(child, indent + 2, cid, ctx);
        sub[0] = pad + ySpan('y-p', '- ') + sub[0].slice(indent + 2);
        out = out.concat(sub);
      } else {
        out.push(pad + ySpan('y-p', '- ') + (yIsCont(child) ? ySpan('y-p', Array.isArray(child) ? '[]' : '{}') : yScalar(child, cid, ctx)));
      }
    }
    return out;
  }
  keys = Object.keys(v);
  for (i = 0; i < keys.length; i++) {
    k = keys[i]; child = v[k]; cid = id + '.' + k;
    if (yIsCont(child) && !yEmpty(child)) {
      out.push(pad + yKey(k) + ySpan('y-p', ':'));
      out = out.concat(yLines(child, indent + 2, cid, ctx));
    } else {
      out.push(pad + yKey(k) + ySpan('y-p', ': ') + (yIsCont(child) ? ySpan('y-p', Array.isArray(child) ? '[]' : '{}') : yScalar(child, cid, ctx)));
    }
  }
  return out;
}
// Whole value -> HTML for a <pre>. A top-level scalar renders as one line.
function yamlHtml(v, id, ctx) {
  if (!yIsCont(v) || yEmpty(v)) return yIsCont(v) ? ySpan('y-p', Array.isArray(v) ? '[]' : '{}') : yScalar(v, id, ctx);
  return yLines(v, 0, id, ctx).join('\n');
}
// The wire/storage form of one event: a single JSONL line.
function rawLine(e) { return JSON.stringify(e); }
function rawStream(events) {
  var asc = events.slice().sort(function (a, b) { return a.seq - b.seq; });
  var out = [];
  for (var i = 0; i < asc.length; i++) out.push(rawLine(asc[i]));
  return out.join('\n');
}
`
