/**
 * The dashboard page: one HTML document, no framework, no build step. It polls
 * `/api/dashboard` every second and only draws what `view.ts` prepared (tested there).
 * Made to be read in a 1080p video: large type, high contrast, dark, no dense tables.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>solana-rug-radar</title>
<style>
  :root { --bg:#0b0d12; --panel:#141821; --line:#262c3a; --text:#eef1f7; --dim:#9aa3b5; --red:#ff4d4f; --amber:#ffb020; --green:#35d07f; --blue:#6cb6ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:20px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  a { color:var(--blue); text-decoration:none; } a:hover { text-decoration:underline; }
  .mono { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
  header { display:flex; justify-content:space-between; align-items:center; gap:24px; padding:14px 28px; border-bottom:1px solid var(--line); }
  h1 { margin:0; font-size:34px; } .tagline { color:var(--dim); font-size:21px; margin-top:2px; }
  .badge { border-radius:12px; padding:10px 18px; font-weight:700; font-size:22px; text-align:right; white-space:nowrap; }
  .badge small { display:block; font-weight:400; font-size:16px; color:var(--text); opacity:.85; white-space:normal; max-width:520px; }
  .live { background:#0f2e1e; border:2px solid var(--green); color:var(--green); }
  .replay { background:#2e230c; border:2px solid var(--amber); color:var(--amber); }
  .finished { background:#23262e; border:2px solid var(--dim); color:var(--text); }
  .down { background:#3a1214; border:2px solid var(--red); color:var(--red); }
  main { display:grid; grid-template-columns: 1.55fr 1fr; gap:20px; padding:16px 28px 20px; align-items:start; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px 20px; }
  h2 { margin:0 0 8px; font-size:24px; } h2 .hint { font-weight:400; color:var(--dim); font-size:17px; }
  .side section { padding:10px 16px; } .side h2 { font-size:22px; margin-bottom:4px; }
  .seq { border-top:1px solid var(--line); padding:9px 0; } .side .seq { padding:5px 0; } .seq:first-of-type { border-top:0; }
  .row { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .t { font-weight:700; min-width:108px; }
  .tag { font-weight:800; border-radius:6px; padding:0 8px; font-size:17px; }
  .tag.red { background:var(--red); color:#1a0506; } .tag.amber { background:var(--amber); color:#1d1300; } .tag.rug { background:#e6e6e6; color:#111; }
  .lead { color:var(--green); font-weight:800; font-size:24px; margin:2px 0 2px 26px; display:flex; align-items:center; gap:14px; }
  .dot { display:inline-block; width:14px; height:14px; border-radius:50%; flex:none; align-self:center; }
  .dot.red { background:var(--red); } .dot.amber { background:var(--amber); } .dot.rug { background:#e6e6e6; border-radius:3px; }
  .bar { height:12px; background:#1f2533; border-radius:6px; flex:1; max-width:420px; overflow:hidden; }
  .bar > div { height:100%; background:var(--green); }
  .prec { color:var(--dim); font-size:17px; }
  .dim { color:var(--dim); } .small { font-size:17px; }
  .empty { color:var(--dim); font-size:20px; padding:10px 0; }
  .side { display:flex; flex-direction:column; gap:16px; }
  #seqbox { height:calc(100vh - 330px); min-height:420px; overflow:hidden; }
  .rule { border-left:6px solid; padding:2px 12px; margin-bottom:8px; }
  .rule.red { border-color:var(--red); } .rule.amber { border-color:var(--amber); }
  .big { font-size:28px; font-weight:800; }
  .blind { border:2px solid var(--amber); }
  .stats { display:flex; flex-wrap:wrap; gap:6px 24px; } .stats b { font-size:21px; }
  details summary { cursor:pointer; color:var(--blue); }
  ul { margin:6px 0 0; padding-left:20px; } li { margin:2px 0; }
</style>
</head>
<body>
<header>
  <div>
    <h1>solana-rug-radar</h1>
    <div class="tagline">Watches every Solana token launch live and warns <b>before</b> the creator drains the pool.</div>
  </div>
  <div id="mode" class="badge finished">…</div>
</header>
<main>
  <div class="side">
    <section id="seqbox">
      <h2>Warned before the drain <span class="hint">alert → confirmed drain, newest first</span></h2>
      <div id="sequences"></div>
    </section>
    <section><h2>System</h2><div id="system" class="stats"></div>
      <details style="margin-top:8px"><summary class="small">Signals we tested and dropped, with data</summary><ul id="dropped" class="small"></ul>
      <div class="small dim">Details: <a href="https://github.com/alebeta06/solana-rug-radar#signals-we-dropped-and-why" target="_blank">README</a></div></details>
    </section>
  </div>
  <div class="side">
    <section><h2>Open alerts <span class="hint">no drain yet</span></h2><div id="open"></div></section>
    <section><h2>Precision by rule <span class="hint">never averaged</span></h2><div id="rules"></div></section>
    <section class="blind" id="blind"></section>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const hms = (s) => new Date(s * 1000).toISOString().slice(11, 19);
const dur = (s) => (s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s');
const pct = (x) => (100 * x).toFixed(1) + ' %';
const usd = (x) => '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const short = (m) => m.slice(0, 6) + '…' + m.slice(-4);
const link = (url, text) => '<a class="mono" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text) + ' ↗</a>';
const dot = (kind) => '<span class="dot ' + kind + '"></span>';

function alertLine(a) {
  // The rule's own measured precision travels on the alert's tag: never an average of both rules.
  return '<div class="row">' + dot(a.level) + '<span class="t mono">' + hms(a.at) + '</span>' +
    '<span class="tag ' + a.level + '" title="' + a.confirmed + ' of ' + a.fired + ' alerts of this rule ended in a drain">' + a.level.toUpperCase() + ' · ' + pct(a.precision) + '</span>' +
    link(a.tokenUrl, short(a.mint)) + '<span' + (a.fingerprint ? ' title="84.99 SOL: the fingerprint of 420 of the 422 drained red cases (confirmation, not a rule)"' : '') + '>' + esc(a.what) + '</span>' +
    (a.latencySeconds !== null ? '<span class="prec">alerted ' + a.latencySeconds + ' s after the block' + (a.origin === 'realtime' ? '' : ' (raised from the ' + esc(a.origin) + ' sent on connecting)') + '</span>' : '') + '</div>';
}

function render(v) {
  const m = $('mode');
  const clock = v.clock === null ? '—' : hms(v.clock) + ' UTC';
  if (v.mode === 'live' && v.warmingUp) { m.className = 'badge replay'; m.innerHTML = '◌ STARTING · not live yet<small>Rebuilding memory from the last 24 h of saved stream (events up to ' + clock + '). Alerts start once connected.</small>'; }
  else if (v.mode === 'live' && !v.connected) { m.className = 'badge down'; m.innerHTML = '◌ LIVE STREAM NOT CONNECTED · ' + esc(v.system.state) + '<small>Last event ' + clock + '. Reconnecting; what you see is not current.</small>'; }
  else if (v.mode === 'live') { m.className = 'badge live'; m.innerHTML = '● LIVE · ' + clock + '<small>Solana mainnet, Solami Blur stream, real time</small>'; }
  else if (v.mode === 'replay') { m.className = 'badge replay'; m.innerHTML = '▶ REPLAY · recorded ' + esc(v.day ?? '') + ' · ' + (v.speed ? v.speed + '×' : 'max speed') + '<small>Event clock ' + clock + '. NOT real time: a recorded capture replayed through the real detector' + (v.speed ? ', ' + v.speed + ' times faster' : '') + '.</small>'; }
  else { m.className = 'badge finished'; m.innerHTML = '■ REPLAY FINISHED · recorded ' + esc(v.day ?? '') + '<small>Final state at ' + clock + ' event time. Nothing is arriving. Set SOLAMI_API_KEY to watch live.</small>'; }

  $('sequences').innerHTML = v.sequences.length === 0
    ? '<div class="empty">' + (v.mode === 'live' ? 'No drain confirmed yet in this session. On the measured night red alerts came ~40 an hour and the drain followed a median 8 min later. Watch "Open alerts".' : 'Replaying… the first alerts appear within the first minute.') + '</div>'
    : v.sequences.map((s) => '<div class="seq">' + s.alerts.map(alertLine).join('') +
        '<div class="lead">' + dur(s.leadSeconds) + ' of warning <div class="bar"><div style="width:' + Math.min(100, (100 * s.leadSeconds) / 900) + '%"></div></div></div>' +
        '<div class="row">' + dot('rug') + '<span class="t mono">' + hms(s.drain.at) + '</span><span class="tag rug">DRAINED</span><b>' + usd(s.drain.peakUsd) + ' → ' + usd(s.drain.lastUsd) + '</b><span title="' + esc(s.drain.mechanism) + '">' + esc(s.drain.what) + '</span>' + link(s.drain.actorUrl, 'wallet') + '</div></div>').join('');

  const open = v.open.map((a) => '<div class="seq row">' + dot(a.level) + '<span class="tag ' + a.level + '">' + a.level.toUpperCase() + ' · ' + pct(a.precision) + '</span>' + link(a.tokenUrl, short(a.mint)) +
      (a.ageSeconds === null ? '' : '<span><b>' + dur(a.ageSeconds) + '</b> ago</span>') + '<span class="small dim">drain usually ~' + dur(a.typicalLeadSeconds) + ' after · creator ' + link(a.creatorUrl, short(a.creator)) + '</span></div>').join('');
  const more = v.openTotal > v.open.length ? '<div class="small dim">+ ' + (v.openTotal - v.open.length) + ' more open</div>' : '';
  const unconf = v.unconfirmed.map((a) => '<div class="small row">' + dot(a.level) + link(a.tokenUrl, short(a.mint)) + '<span class="dim">' + hms(a.at) + ' · no drain within 60 min: counts against precision</span></div>').join('');
  $('open').innerHTML = (open || '<div class="empty">None right now.</div>') + more + (unconf ? '<div style="margin-top:6px"><b class="small">Alerted, but NOT drained</b>' + unconf + '</div>' : '');

  const caveat = v.selectionCaveat === null ? '' : '<div class="small dim" style="margin-top:4px">' + esc(v.selectionCaveat) + '</div>';
  $('rules').innerHTML = v.rules.map((r) => '<div class="rule ' + r.level + '"><div class="row"><span class="big">' + pct(r.measured.precision) + '</span><b>' + esc(r.name) + '</b></div>' +
      '<div class="small">' + esc(r.meaning) + '. <span class="dim">Measured on a full night: ' + r.measured.confirmed + ' of ' + r.measured.fired + ' drained, median warning ' + dur(r.measured.medianLeadSeconds) + '.</span></div>' +
      '<div class="small">' + esc(v.scope) + ': ' + r.live.fired + ' fired · ' + r.live.confirmed + ' drained · ' + r.live.unconfirmed + ' not drained · ' + r.live.open + ' open' +
      (r.live.precision === null ? '' : ' · <b>precision ' + pct(r.live.precision) + '</b>') + '</div></div>').join('') + caveat;

  const s = v.blind.session;
  const unwarned = Object.entries(s.unwarnedByMechanism).map(([k, n]) => n + ' ' + esc(k)).join(', ');
  $('blind').innerHTML = '<h2>What it does NOT see</h2><div class="small">It warned before <b>' + pct(v.blind.measuredRecall) + '</b> of the pool rugs of a full measured night. Blind to ' + esc(v.blind.text) + '</div>' +
      '<div class="small" style="margin-top:4px"><b>' + esc(v.scope) + ':</b> ' + s.rugs + ' drains confirmed, ' + s.warned + ' warned before' + (unwarned ? '; <b>no warning: ' + unwarned + '</b>' : '') + '.</div>' + caveat;

  const y = v.system;
  const stat = (label, value) => '<div><div class="small dim">' + label + '</div><b>' + value + '</b></div>';
  $('system').innerHTML = [
    stat('Stream', esc(y.state)),
    v.mode === 'live' ? stat('Events / s', y.eventsPerSecond === null ? '…' : Math.round(y.eventsPerSecond).toLocaleString('en-US')) : stat('Frames replayed', y.frames.toLocaleString('en-US')),
    stat('Tokens in memory', y.tokens.toLocaleString('en-US') + ' <span class="small dim">(' + y.graduated + ' graduated)</span>'),
    stat('Creators', y.creators.toLocaleString('en-US')),
    y.rest ? stat('REST ' + (y.rest.mode === 'live' ? '(1 req/s)' : '(simulated)'), y.rest.sent + ' sent · ' + y.rest.pending + ' queued') : '',
    y.reconnects !== null ? stat('Reconnects', y.reconnects) : '',
    stat('Memory', y.heapMB + ' MB'),
  ].join('');
  $('dropped').innerHTML = v.dropped.map((d) => '<li><b>' + esc(d.signal) + '</b> — <span class="dim">' + esc(d.why) + '</span></li>').join('');
}

async function tick() {
  try {
    const res = await fetch('/api/dashboard', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
  } catch {
    const m = $('mode');
    m.className = 'badge down';
    m.innerHTML = '■ DISCONNECTED<small>The radar process is not answering: what you see is stale.</small>';
  }
}
tick();
setInterval(tick, 1000);
</script>
</body>
</html>
`;
