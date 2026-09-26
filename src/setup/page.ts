import { brandLogo, brandMark } from "../brand";

const FAVICON = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#090d12"/>${brandMark("#F5F4F0", "#CB9459")}</svg>`);

/** Brand header: the shared logo files, or the mark plus a text wordmark if assets are missing. */
function brandHeader(): string {
  const light = brandLogo("light");
  const dark = brandLogo("dark");
  if (light && dark) return `<span class="logo logo-light">${light}</span><span class="logo logo-dark">${dark}</span>`;
  return `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true">${brandMark("currentColor", "var(--accent)")}</svg><span class="wordmark">Cicero</span>`;
}

/** Self-contained guided setup page: a clickable voice-loop diagram, then one question per step. */
export function setupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cicero setup</title>
<meta name="description" content="Set up Cicero, the self-hosted voice layer for coding agents.">
<link rel="icon" href="${FAVICON}">
<style>
:root{
  --bg:#F5F4F0; --surface:#FCFBF8; --ink:#17181C; --muted:#625E56; --line:#DFDBD1;
  --accent:#A9713A; --accent-text:#835525; --accent-soft:#F2E7D8; --accent-line:#D6B28B;
  --ok:#2A7A55; --ok-soft:#E4F0E8; --bad:#B23A2B; --bad-soft:#F8E6E2;
  --r-outer:14px; --r-inner:12px; --r-ctl:8px;
  --ease:cubic-bezier(.16,1,.3,1);
  --shadow:0 1px 2px rgb(23 24 28/.05), 0 10px 28px -14px rgb(23 24 28/.22);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#090D12; --surface:#11161D; --ink:#F5F4F0; --muted:#9A9DA4; --line:#252B34;
  --accent:#CB9459; --accent-text:#D9A56B; --accent-soft:#241C14; --accent-line:#6E5234;
  --ok:#5CBF8C; --ok-soft:#12251B; --bad:#F07A6A; --bad-soft:#2A1512;
  --shadow:0 1px 2px rgb(0 0 0/.3), 0 12px 32px -16px rgb(0 0 0/.6);
  color-scheme:dark;
}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
a{color:var(--accent-text)}
:focus-visible{outline:3px solid var(--accent-line);outline-offset:3px}
.skip{position:absolute;left:16px;top:-48px;z-index:10;background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:var(--r-ctl);text-decoration:none;font-weight:600;transition:top .2s var(--ease)}
.skip:focus{top:12px}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.035;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.wrap{position:relative;z-index:1}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{max-width:980px;margin:0 auto;padding:36px 24px 96px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:44px}
.brand{display:flex;align-items:center;gap:12px;background:none;border:0;padding:0;cursor:pointer;color:var(--ink)}
.brand .logo svg{display:block;height:30px;width:auto}
.brand .logo-dark{display:none}
@media (prefers-color-scheme:dark){.brand .logo-light{display:none}.brand .logo-dark{display:block}}
.brand .mark{width:34px;height:34px}
.brand .wordmark{font-size:21px;font-weight:700;letter-spacing:-.01em}
.brand .tag{color:var(--muted);font-size:15px;font-weight:500;padding-left:12px;border-left:1px solid var(--line);line-height:1.2}
.overview-link{background:none;border:0;color:var(--accent-text);cursor:pointer;padding:6px 0;font-weight:600;transition:opacity .2s var(--ease)}
.overview-link:hover{opacity:.75}
h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;font-weight:700;margin:0 0 12px;text-wrap:balance}
.lede{color:var(--muted);font-size:17px;margin:0 0 36px;max-width:60ch;text-wrap:pretty}
.section-h2{font-size:18px;font-weight:600;margin:0 0 12px}
#app{transition:opacity .2s var(--ease)}
#app[aria-busy="true"]{opacity:.6;pointer-events:none}

/* Overview diagram */
.diagram{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-outer);padding:28px;box-shadow:var(--shadow)}
.diagram svg{display:block;width:100%;height:auto}
.diagram .tall{display:none}
@media (max-width:720px){.diagram .wide{display:none}.diagram .tall{display:block}.diagram{padding:16px}}
.node{cursor:pointer}
.node rect.box{fill:var(--surface);stroke:var(--line);stroke-width:1.5;transition:stroke .2s var(--ease),fill .2s var(--ease)}
.node:hover rect.box,.node:focus-visible rect.box{stroke:var(--accent);fill:var(--accent-soft)}
.node:focus{outline:none}
.node .title{font-size:19px;font-weight:700;fill:var(--ink)}
.node .sub{font-size:13px;fill:var(--muted)}
.node .value{font-size:14px;font-weight:600;fill:var(--ink)}
.node.done rect.box{stroke:var(--ok)}
.node .dot{fill:var(--line)}
.node.done .dot{fill:var(--ok)}
.edge{stroke:var(--line);stroke-width:2;fill:none}
.edge.soft{stroke-dasharray:5 6}
.edge-label{font-size:12px;fill:var(--muted)}
.person{fill:var(--accent-soft);stroke:var(--accent-line);stroke-width:1.5}
.person-label{font-size:13px;font-weight:600;fill:var(--ink)}
.cta-row{display:flex;justify-content:flex-end;margin-top:28px;gap:12px;flex-wrap:wrap}

/* Chain nav on step screens */
.chain{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 40px;padding:0;list-style:none}
.chain button{display:flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:7px 14px;cursor:pointer;font-size:14px;color:var(--muted);transition:color .2s var(--ease),border-color .2s var(--ease)}
.chain button:hover{color:var(--ink);border-color:var(--accent-line)}
.chain button[aria-current="step"]{border-color:var(--accent);color:var(--ink);font-weight:600}
.chain .tick{color:var(--ok);font-weight:700;font-size:13px}

/* Choice cards */
.choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin:0 0 28px;padding:0;border:0}
.choice{position:relative;display:block;background:var(--surface);border:1.5px solid var(--line);border-radius:var(--r-inner);padding:20px 20px 18px;cursor:pointer;transition:border-color .2s var(--ease),box-shadow .2s var(--ease),transform .2s var(--ease)}
.choice:hover{border-color:var(--accent-line)}
.choice:active{transform:scale(.98)}
.choice input{position:absolute;opacity:0;pointer-events:none}
.choice:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset,var(--shadow)}
.choice:has(input:focus-visible){outline:3px solid var(--accent-line);outline-offset:3px}
.choice .name{display:block;font-size:17px;font-weight:600;margin-bottom:6px}
.choice .state ~ .name{padding-right:104px}
.choice .note{display:block;color:var(--muted);font-size:14px;line-height:1.5;text-wrap:pretty}
.choice .state{position:absolute;top:18px;right:18px;display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--muted)}
.choice .state i{width:7px;height:7px;border-radius:50%;background:var(--ok);display:none}
.choice .state.on i{display:inline-block}
.choice .state.on{color:var(--ok)}
.badge{display:inline-block;margin-top:12px;font-size:12.5px;font-weight:600;color:var(--accent-text);background:var(--accent-soft);border-radius:4px;padding:2px 8px}

/* Form + panels */
.fields{display:grid;gap:18px;max-width:560px;margin:0 0 28px}
.field span{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
.field small{display:block;color:var(--muted);font-size:13px;margin-top:6px}
.field input,.field select{width:100%;padding:11px 14px;border:1.5px solid var(--line);border-radius:var(--r-ctl);background:var(--surface);transition:border-color .2s var(--ease),box-shadow .2s var(--ease)}
.field input:focus,.field select:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
.check-inline{display:flex;gap:10px;align-items:flex-start;font-size:15px;margin:0 0 20px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-outer);padding:20px 22px;margin:0 0 24px;max-width:720px}
.panel.warn{border-color:var(--accent-line);background:var(--accent-soft)}
.panel h2{font-size:16px;margin:0 0 10px;font-weight:600}
.panel p{margin:0 0 10px;text-wrap:pretty}
.panel p:last-child{margin-bottom:0}
.panel ol{margin:0;padding-left:20px}
.panel li{margin:0 0 10px}
details.why{margin:0 0 28px;max-width:720px}
details.why summary{cursor:pointer;color:var(--accent-text);font-weight:600;padding:4px 0}
details.why div{padding:12px 0 0;color:var(--muted)}
details.why p{margin:0 0 10px}
.cmd{display:flex;align-items:center;gap:10px;margin:8px 0 0;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-ctl);padding:8px 8px 8px 12px}
.cmd code{flex:1;font:13.5px/1.5 var(--mono);overflow-x:auto;white-space:pre}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:20px 0;margin:0 0 32px}
.fact{padding:2px 20px;border-left:1px solid var(--line)}
.fact b{display:block;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.fact small{color:var(--muted);font-size:13.5px}
.note-line{color:var(--muted);margin:-12px 0 28px}
.note-line.tight{margin:0 0 14px}
.warnline{color:var(--accent-text);font-weight:600;margin:0 0 28px}

/* Review */
.summary{display:flex;gap:12px;flex-wrap:wrap;margin:0 0 28px}
.pill{border-radius:var(--r-ctl);padding:6px 14px;font-size:14px;font-weight:600;background:var(--surface);border:1px solid var(--line);font-variant-numeric:tabular-nums}
.pill.ok{color:var(--ok);border-color:var(--ok);background:var(--ok-soft)}
.pill.todo{color:var(--accent-text);border-color:var(--accent-line);background:var(--accent-soft)}
.pill.bad{color:var(--bad);border-color:var(--bad);background:var(--bad-soft)}
.rows{list-style:none;margin:0 0 28px;padding:0;max-width:760px;border:1px solid var(--line);border-radius:var(--r-outer);background:var(--surface)}
.rows li{padding:14px 18px;border-top:1px solid var(--line)}
.rows li:first-child{border-top:0}
.rows .name{font-weight:600}
.rows .detail{color:var(--muted);font-size:14px;margin:4px 0 0}
pre.yaml{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-outer);padding:18px 20px;font:13.5px/1.6 var(--mono);overflow-x:auto;max-width:760px;margin:12px 0 0}

/* Buttons */
.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:8px}
.btn{border-radius:var(--r-ctl);padding:11px 22px;font-weight:600;cursor:pointer;border:1.5px solid var(--line);background:var(--surface);transition:transform .2s var(--ease),background-color .2s var(--ease),border-color .2s var(--ease),filter .2s var(--ease)}
.btn:hover:not(:disabled){border-color:var(--accent-line)}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.btn.primary:hover:not(:disabled){filter:brightness(1.18);border-color:var(--ink)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.small{padding:6px 12px;font-size:13.5px}
.error{color:var(--bad);font-weight:600;margin:12px 0 0}
.done-mark{font-size:40px;line-height:1;margin-bottom:16px;color:var(--ok)}
.spacer{height:24px}
@media (max-width:720px){.wrap{padding:24px 16px 72px}h1{font-size:25px}header.top{margin-bottom:28px}.choices{grid-template-columns:1fr}.brand .tag{display:none}}
@media (prefers-reduced-motion:no-preference){
  #app > *{animation:rise .35s var(--ease) both}
  #app > :nth-child(2){animation-delay:40ms} #app > :nth-child(3){animation-delay:80ms} #app > :nth-child(4){animation-delay:120ms} #app > :nth-child(n+5){animation-delay:160ms}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<a class="skip" href="#app">Skip to setup</a>
<div class="wrap">
  <header class="top">
    <button class="brand" id="brand" type="button" aria-label="Cicero setup overview">${brandHeader()}<span class="tag">Setup</span></button>
    <button class="overview-link" id="to-overview" type="button" hidden>Back to overview</button>
  </header>
  <main id="app" aria-live="polite" tabindex="-1"></main>
</div>
<script>
var params = new URLSearchParams(location.search);
var fresh = params.get('token');
if (fresh) { try { sessionStorage.setItem('cicero-setup-token', fresh); } catch (e) {} history.replaceState(null, '', location.pathname + location.hash); }
var token = fresh;
try { token = token || sessionStorage.getItem('cicero-setup-token'); } catch (e) {}
var state = null;
var view = 'overview';
var app = document.getElementById('app');

var ORDER = ['system', 'stt', 'provider', 'router', 'brain', 'tts', 'board', 'review'];
var STEP = {
  system:   { short: 'Machine', title: 'This machine', lede: 'Cicero picks a starting preset from your hardware. You can change it.', sub: 'Runs everything' },
  stt:      { short: 'Hear',    title: 'How should Cicero hear you?', lede: 'Speech-to-text turns your voice into words.', sub: 'Speech-to-text' },
  provider: { short: 'Think',   title: 'Which model handles conversation?', lede: 'A language model answers everyday talk quickly. Coding work goes to the agent.', sub: 'Language model' },
  router:   { short: 'Route',   title: 'How should Cicero route requests?', lede: 'Use the LLM prompt, or a local Laya sidecar with your fine-tuned switchboard checkpoint.', sub: 'Intent router' },
  brain:    { short: 'Agent',   title: 'Which coding agent does the work?', lede: 'Cicero is the voice. Your agent reads code, runs tools and opens PRs.', sub: 'Coding agent' },
  tts:      { short: 'Speak',   title: 'How should Cicero speak?', lede: 'Text-to-speech turns replies into audio.', sub: 'Text-to-speech' },
  board:    { short: 'Tasks',   title: 'Where do your tasks live?', lede: 'Optional. Cicero can announce when tasks on your board finish or get stuck.', sub: 'Optional board' },
  review:   { short: 'Save',    title: 'Review and save', lede: 'Cicero checks your choices before writing the config.', sub: 'Check and write' }
};
var NAMES = {'llm':'LLM prompt (default)','laya':'Laya sidecar (checkpoint required)','llama-cpp':'llama.cpp','ollama':'Ollama','lm-studio':'LM Studio','mlx-lm':'MLX','openai-compatible':'OpenAI-compatible URL','claude-code':'Claude Code','codex':'Codex','gemini':'Gemini CLI','qwen':'Qwen Code','acp':'ACP agent','faster-whisper':'faster-whisper','mlx-whisper':'MLX Whisper','audiocpp':'audio.cpp','kokoro':'Kokoro','pocket-tts':'Pocket TTS (Python)','mlx-audio':'MLX Audio','elevenlabs':'ElevenLabs','wyoming':'Wyoming server','hermes':'Hermes','multica':'Multica','paperclip':'Paperclip','none':'No board','cloud':'Cloud or custom API','api':'Model API','local-cuda':'NVIDIA GPU','local-mlx':'Apple Silicon','local-cpu':'CPU only'};
function optionName(stepId, option) { return option === 'audiocpp' ? (stepId === 'stt' ? 'Nemotron (audio.cpp)' : 'Pocket TTS (audio.cpp)') : (NAMES[option] || option); }
var NOTES = {
  'llm':'Routes with the conversational LLM; no separate checkpoint needed.',
  'laya':'Base Laya does not route zero-shot. A fine-tuned switchboard checkpoint is required: bring-your-own for now. A public checkpoint trained on synthetic data only plus the fine-tuning recipe are a planned follow-up.',
  'llama-cpp':'Fast local GGUF models.', 'ollama':'Easy local model library.', 'lm-studio':'Desktop app with a local server.', 'mlx-lm':'Local models on Apple Silicon.',
  'cloud':'Any OpenAI-compatible endpoint or a cloud provider.', 'api':'An OpenAI-compatible model API instead of an agent CLI.',
  'claude-code':'Anthropic\\u2019s coding agent.', 'codex':'OpenAI\\u2019s coding agent.', 'gemini':'Google\\u2019s coding agent.', 'qwen':'Qwen\\u2019s coding agent.', 'acp':'Any Agent Client Protocol harness, such as Hermes.',
  'faster-whisper':'Accurate, runs on GPU or CPU.', 'mlx-whisper':'Fast on Apple Silicon.', 'wyoming':'Use a speech server you already run.',
  'kokoro':'Natural preset voices.', 'pocket-tts':'Python sidecar; clone a voice from a short clip.', 'mlx-audio':'Local voices on Apple Silicon.', 'elevenlabs':'Cloud voices. Needs an API key.',
  'hermes':'Live-tested.', 'multica':'Supported, not live-tested yet.', 'paperclip':'Supported, not live-tested yet.', 'none':'Skip task announcements.',
  'local-cuda':'Local speech and models on your NVIDIA card.', 'local-mlx':'Local speech and models on Apple Silicon.', 'local-cpu':'Works anywhere, slower.'
};
var GUIDES = {
  'laya':[['Base Laya does not route zero-shot. A fine-tuned switchboard checkpoint is required: bring-your-own for now. A public checkpoint trained on synthetic data only plus the fine-tuning recipe are a planned follow-up. Read the sidecar guide','https://github.com/5uck1ess/cicero/blob/main/sidecars/laya-switchboard/README.md'],['Start with your checkpoint','uv run --python 3.11 --with-requirements requirements/laya-switchboard.txt python sidecars/laya-switchboard/serve.py --ckpt /path/to/switchboard-checkpoint']],
  'llama-cpp':[['Build or install llama.cpp','https://github.com/ggml-org/llama.cpp'],['Start the server on port 8080','llama-server -m your-model.gguf --port 8080']],
  'ollama':[['Install Ollama','https://ollama.com/download'],['Pull a model','ollama pull qwen3.5:4b']],
  'lm-studio':[['Install LM Studio','https://lmstudio.ai'],['Load a model, then start its local server on port 1234','']],
  'claude-code':[['Install Claude Code','https://docs.anthropic.com/en/docs/claude-code/setup'],['Sign in','claude']],
  'codex':[['Install Codex','https://developers.openai.com/codex/cli/'],['Sign in','codex login']],
  'gemini':[['Install Gemini CLI','https://github.com/google-gemini/gemini-cli'],['Sign in','gemini']],
  'qwen':[['Install Qwen Code','https://github.com/QwenLM/qwen-code'],['Sign in','qwen']],
  'hermes':[['Install Hermes','https://hermes-agent.nousresearch.com']],
  'audiocpp':[['Build the CUDA audio.cpp server','scripts/provision-audiocpp.sh']],
  'elevenlabs':[['After setup, add a voice','cicero voice add']]
};

function h(tag, attrs, kids) {
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k === 'class') n.className = v;
    else if (k.slice(0, 2) === 'on') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  (kids || []).forEach(function (c) { if (c != null) n.append(c); });
  return n;
}
function svg(tag, attrs, kids) {
  var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (var k in attrs || {}) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); }
  (kids || []).forEach(function (c) { if (c) n.append(c); });
  return n;
}
async function api(path, body) {
  var headers = { 'x-cicero-setup-token': token || '' };
  if (body !== undefined) { headers['x-cicero-setup-csrf'] = '1'; headers['content-type'] = 'application/json'; }
  var r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
  var data = await r.json().catch(function () { return {}; });
  if (!r.ok) throw new Error(data.error || 'Setup server did not accept that request.');
  return data;
}
function button(label, cls, fn, errorHost) {
  var b = h('button', { type: 'button', class: 'btn ' + (cls || ''), text: label });
  b.onclick = async function () {
    var host = errorHost || b.parentNode;
    var old = host && host.querySelector(':scope > .error'); if (old) old.remove();
    b.disabled = true;
    try { await fn(); } catch (e) { if (host) host.append(h('p', { class: 'error', role: 'alert', text: e.message })); }
    finally { b.disabled = false; }
  };
  return b;
}
function cmd(text) {
  var copy = h('button', { type: 'button', class: 'btn small', text: 'Copy' });
  copy.onclick = function () { navigator.clipboard && navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); }); };
  return h('div', { class: 'cmd' }, [h('code', { text: text }), copy]);
}
function isDone(id) {
  if (id === 'system') return !!(state.selectedChoices && state.selectedChoices.system);
  if (id === 'review') return !!state.written;
  return !!(state.selectedChoices && state.selectedChoices[id]);
}
function valueFor(id) {
  if (id === 'system') return NAMES[state.tier] || state.tier;
  if (id === 'review') return state.written ? 'Saved' : 'Not saved yet';
  var c = state.selectedChoices && state.selectedChoices[id];
  if (id === 'router' && c) return c === 'laya' ? 'Laya sidecar' : 'LLM prompt';
  return c ? optionName(id, c) : 'Choose';
}
function gib(n) { return n == null ? 'unknown' : (n / 1073741824).toFixed(0) + ' GB'; }

async function go(id) {
  app.setAttribute('aria-busy', 'true');
  try { await goInner(id); } finally { app.removeAttribute('aria-busy'); }
}
async function goInner(id) {
  if (location.hash.slice(1) !== (id === 'overview' ? '' : id)) history.pushState(null, '', id === 'overview' ? location.pathname : '#' + id);
  if (id === 'overview') { view = 'overview'; render(); return; }
  var serverId = id === 'review' ? 'check' : id;
  state = await api('/api/step', { id: serverId });
  view = id;
  if (id === 'review' && !state.written) state = await api('/api/check', {});
  render();
  window.scrollTo(0, 0);
}
// A choice whose probe failed was not added to the draft: keep the operator on that step.
function blockedByProbe(s) { var p = s && s.detected && s.detected.probe; return p && p.ok === false ? (p.message || 'The check failed.') : null; }
var tried = {};
var routerUrl = '';
function next(id) { var i = ORDER.indexOf(id); return ORDER[Math.min(i + 1, ORDER.length - 1)]; }

/* ---------- Overview diagram ---------- */
function diagram(layout) {
  var wide = layout === 'wide';
  var W = wide ? 1140 : 360, H = wide ? 420 : 952;
  var nw = wide ? 180 : 250, nh = 92;
  var pos = wide ? {
    stt: [150, 20], provider: [410, 20], router: [670, 20], brain: [910, 20],
    tts: [280, 190], board: [910, 190], system: [150, 324], review: [910, 324]
  } : {
    system: [55, 0], stt: [55, 120], provider: [55, 240], router: [55, 360], brain: [55, 480], board: [55, 600], tts: [55, 720], review: [55, 860]
  };
  var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': 'Cicero voice loop. Choose a part to set it up.', class: wide ? 'wide' : 'tall' });
  function mid(id, side) {
    var p = pos[id], x = p[0], y = p[1], w = nw;
    if (side === 'r') return [x + w, y + nh / 2]; if (side === 'l') return [x, y + nh / 2];
    if (side === 't') return [x + w / 2, y]; return [x + w / 2, y + nh];
  }
  function edge(a, b, soft, label, lx, ly) {
    root.append(svg('path', { d: 'M' + a[0] + ' ' + a[1] + ' L' + b[0] + ' ' + b[1], class: 'edge' + (soft ? ' soft' : ''), 'marker-end': 'url(#arrow-' + layout + ')' }));
    if (label) root.append(svg('text', { x: lx, y: ly, class: 'edge-label', 'text-anchor': 'middle', text: label }));
  }
  root.append(svg('defs', {}, [svg('marker', { id: 'arrow-' + layout, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, [svg('path', { d: 'M0 0 L10 5 L0 10 z', fill: 'var(--muted)' })])]));
  if (wide) {
    root.append(svg('circle', { cx: 56, cy: 66, r: 34, class: 'person' }));
    root.append(svg('text', { x: 56, y: 71, 'text-anchor': 'middle', class: 'person-label', text: 'You' }));
    edge([90, 66], mid('stt', 'l'), false, 'talk', 120, 56);
    edge(mid('stt', 'r'), mid('provider', 'l'), false, 'words', 370, 56);
    edge(mid('provider', 'r'), mid('router', 'l'), false, 'route', 630, 56);
    edge(mid('router', 'r'), mid('brain', 'l'), false, 'code', 880, 56);
    edge([480, 112], [400, 190], false, 'reply', 462, 158);
    edge(mid('brain', 'b'), mid('board', 't'), true, 'tasks', 1030, 156);
    edge(mid('tts', 'l'), [72, 96], false, 'hear it', 150, 170);
  } else {
    edge(mid('system', 'b'), mid('stt', 't'), true);
    edge(mid('stt', 'b'), mid('provider', 't'), false);
    edge(mid('provider', 'b'), mid('router', 't'), false);
    edge(mid('router', 'b'), mid('brain', 't'), false);
    edge(mid('brain', 'b'), mid('board', 't'), true);
    edge(mid('board', 'b'), mid('tts', 't'), false);
    edge(mid('tts', 'b'), mid('review', 't'), true);
  }
  Object.keys(pos).forEach(function (id) {
    var p = pos[id], w = nw, done = isDone(id);
    var g = svg('g', { class: 'node ' + (done ? 'done' : 'todo'), tabindex: 0, role: 'button', 'aria-label': STEP[id].short + ': ' + valueFor(id) + (done ? ', done' : ', not set') });
    g.append(svg('rect', { class: 'box', x: p[0], y: p[1], width: w, height: nh, rx: 16 }));
    g.append(svg('circle', { class: 'dot', cx: p[0] + w - 20, cy: p[1] + 22, r: 6 }));
    g.append(svg('text', { class: 'title', x: p[0] + 20, y: p[1] + 32, text: STEP[id].short }));
    g.append(svg('text', { class: 'sub', x: p[0] + 20, y: p[1] + 52, text: STEP[id].sub }));
    g.append(svg('text', { class: 'value', x: p[0] + 20, y: p[1] + 76, text: valueFor(id) }));
    g.onclick = function () { go(id).catch(showFatal); };
    g.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(id).catch(showFatal); } };
    root.append(g);
  });
  return root;
}
function renderOverview() {
  var firstOpen = ORDER.find(function (id) { return !isDone(id); }) || 'review';
  app.append(
    h('h1', { text: 'Set up your voice loop' }),
    h('p', { class: 'lede', text: 'Click any part to set it up. Nothing is written until you save.' }),
    h('div', { class: 'diagram' }, [diagram('wide'), diagram('tall')]),
    h('div', { class: 'cta-row' }, [button(isDone('system') ? 'Continue setup' : 'Start with this machine', 'primary', function () { return go(firstOpen); })])
  );
}

/* ---------- Step screens ---------- */
function chain(current) {
  var ol = h('ol', { class: 'chain', 'aria-label': 'Setup steps' });
  ORDER.forEach(function (id) {
    var done = isDone(id);
    var b = h('button', { type: 'button', 'aria-current': id === current ? 'step' : false, 'aria-label': STEP[id].short + (done ? ', done' : '') }, [done ? h('span', { class: 'tick', 'aria-hidden': 'true', text: '\\u2713' }) : null, document.createTextNode(STEP[id].short)]);
    b.onclick = function () { go(id).catch(showFatal); };
    ol.append(h('li', {}, [b]));
  });
  return ol;
}
function why(step) {
  if (!step || !step.explain) return null;
  var e = step.explain;
  var body = h('div', {}, [h('p', { text: e.why }), h('p', { text: e.happens })]);
  if (e.learnMore) body.append(h('p', {}, [h('a', { href: 'https://github.com/5uck1ess/cicero/blob/main/' + e.learnMore, target: '_blank', rel: 'noopener noreferrer', text: 'Read the full guide' })]));
  return h('details', { class: 'why' }, [h('summary', { text: 'Why this?' }), body]);
}
function stateLabel(option, f) {
  var rt = f.runtimes && f.runtimes[option];
  if (rt) return rt.running ? ['Running', true] : ['Not running', false];
  var inst = f.installed && f.installed[option];
  if (inst !== undefined) { var ok = typeof inst === 'object' ? inst.found : inst; return ok ? ['Installed', true] : ['Not found', false]; }
  var st = f.status && f.status[option];
  if (st) { if (!st.installed) return ['Not installed', false]; if (st.modelPresent === false) return ['Model missing', false]; if (st.running && st.modelLoaded !== undefined && st.modelLoaded !== true) return [st.modelLoaded === null ? 'Model not verified' : 'Model not loaded', false]; if (st.running) return ['Running', true]; return ['Installed', true]; }
  return null;
}
function field(label, input) { return h('label', { class: 'field' }, [h('span', { text: label }), input]); }
function textInput(value, type) { return h('input', { type: type || 'text', value: value || '', autocomplete: 'off' }); }
function selectOf(items, value) {
  var s = h('select');
  items.forEach(function (m) { var o = h('option', { value: m, text: NAMES[m] || m }); if (m === value) o.selected = true; s.append(o); });
  return s;
}

function renderSystem(step) {
  var f = state.detected || state.system;
  var gpu = f.gpu && f.gpu.status === 'ok' ? f.gpu.name : 'No NVIDIA GPU';
  var vram = f.gpu && f.gpu.status === 'ok' ? Math.round(f.gpu.totalMiB / 1024) + ' GB VRAM' : 'CPU or Apple GPU';
  app.append(h('div', { class: 'facts' }, [
    h('div', { class: 'fact' }, [h('b', { text: gpu }), h('small', { text: vram })]),
    h('div', { class: 'fact' }, [h('b', { text: gib(f.ramTotalBytes) + ' RAM' }), h('small', { text: gib(f.ramFreeBytes) + ' free' })]),
    h('div', { class: 'fact' }, [h('b', { text: f.platform === 'darwin' ? 'macOS' : f.platform === 'win32' ? 'Windows' : 'Linux' }), h('small', { text: f.arch })]),
    h('div', { class: 'fact' }, [h('b', { text: gib(f.disks && f.disks.checkout.freeBytes) }), h('small', { text: 'free disk' })])
  ]));
  if (f.gpuWarning) app.append(h('p', { class: 'warnline', text: f.gpuWarning }));
  var picked = state.tier;
  var group = h('fieldset', { class: 'choices' }, [h('legend', { class: 'sr', text: 'Starting preset' })]);
  ['local-cuda', 'local-mlx', 'local-cpu'].forEach(function (t) {
    var input = h('input', { type: 'radio', name: 'tier', value: t });
    input.checked = t === picked;
    input.onchange = function () { picked = t; };
    group.append(h('label', { class: 'choice' }, [input, h('span', { class: 'name', text: NAMES[t] }), h('span', { class: 'note', text: NOTES[t] }), t === f.recommendedTier ? h('span', { class: 'badge', text: 'Recommended' }) : null]));
  });
  app.append(group, why(step));
  var row = h('div', { class: 'actions' });
  row.append(button('Continue', 'primary', async function () { state = await api('/api/choice', { id: 'system', choice: picked }); await go(next('system')); }, row));
  app.append(row);
}

function renderPicker(id, step) {
  var f = state.detected || {};
  var options, extra = null;
  if (id === 'provider') {
    options = ['llama-cpp', 'ollama', 'lm-studio'].concat(f.mlxAvailable ? ['mlx-lm'] : []).concat(['cloud']);
    extra = { key: 'cloud', items: ['openai-compatible'].concat(f.cloudPresets || []) };
  } else if (id === 'brain') {
    var all = f.options || [];
    var clis = ['claude-code', 'codex', 'gemini', 'qwen', 'acp'].filter(function (o) { return all.indexOf(o) >= 0; });
    options = clis.concat(['api']);
    extra = { key: 'api', items: all.filter(function (o) { return clis.indexOf(o) < 0; }) };
  } else if (id === 'board') {
    options = ['hermes', 'multica', 'paperclip', 'none'];
  } else {
    options = f.options || [];
  }
  var saved = state.selectedChoices && state.selectedChoices[id];
  var picked = (blockedByProbe(state) && tried[id]) || saved || f.recommended || options[0];
  if (extra && extra.items.indexOf(picked) >= 0) { extra.value = picked; picked = extra.key; }
  if (extra && !extra.value) extra.value = extra.items[0];

  var group = h('fieldset', { class: 'choices' }, [h('legend', { class: 'sr', text: STEP[id].title })]);
  var detail = h('div');
  function realId() { return extra && picked === extra.key ? extra.value : picked; }
  function draw() {
    group.querySelectorAll('.choice').forEach(function (n) { n.remove(); });
    options.forEach(function (o) {
      var input = h('input', { type: 'radio', name: 'pick-' + id, value: o });
      input.checked = o === picked;
      input.onchange = function () { picked = o; drawDetail(); };
      var s = stateLabel(o, f);
      var rt = f.runtimes && f.runtimes[o];
      var note = o === 'audiocpp' ? (id === 'stt' ? 'Fast, accurate English ASR with Nemotron’s streaming model on an NVIDIA GPU; needs the audio.cpp build.' : 'Voice cloning on an NVIDIA GPU; needs the audio.cpp build.') : (NOTES[o] || '');
      if (rt && rt.running && rt.models && rt.models.length) note += ' ' + rt.models.length + ' models loaded.';
      group.append(h('label', { class: 'choice' }, [input,
        s ? h('span', { class: 'state' + (s[1] ? ' on' : '') }, [h('i'), document.createTextNode(s[0])]) : null,
        h('span', { class: 'name', text: optionName(id, o) }), h('span', { class: 'note', text: note }),
        o === f.recommended || (extra && o === extra.key && extra.items.indexOf(f.recommended) >= 0) ? h('span', { class: 'badge', text: 'Recommended' }) : null]));
    });
  }
  var fields = {};
  function drawDetail() {
    detail.replaceChildren(); fields = {};
    var o = realId();
    var box = h('div', { class: 'fields' });
    if (extra && picked === extra.key) {
      var sel = selectOf(extra.items, extra.value);
      sel.onchange = function () { extra.value = sel.value; drawDetail(); };
      box.append(field(id === 'provider' ? 'Provider' : 'Model API', sel));
    }
    var rt = f.runtimes && f.runtimes[o];
    if (id === 'router' && o === 'laya') {
      fields.url = textInput(routerUrl || f.defaultUrl, 'url');
      fields.url.oninput = function () { routerUrl = this.value; };
      box.append(field('Laya sidecar URL', fields.url));
    }
    if (id === 'provider' && o === 'llama-cpp') fields.model = textInput(f.defaultModel), box.append(field('Model (GGUF file path or Hugging Face repo)', fields.model));
    if (id === 'provider' && (o === 'ollama' || o === 'lm-studio') && rt && rt.models.length) fields.model = selectOf(rt.models), box.append(field('Model', fields.model));
    var remote = id === 'provider' && ['llama-cpp', 'ollama', 'lm-studio', 'mlx-lm'].indexOf(o) < 0;
    if (remote) {
      if (o === 'openai-compatible') fields.baseUrl = textInput(state.providerModels && state.providerModels.id === o ? state.providerModels.baseUrl : 'http://127.0.0.1:8000/v1', 'url'), box.append(field('API base URL', fields.baseUrl));
      fields.apiKey = textInput('', 'password'); box.append(field('API key (optional for local servers)', fields.apiKey));
      fields.model = selectOf(state.providerModels && state.providerModels.id === o ? state.providerModels.models : []);
      box.append(field('Model', fields.model));
      var listRow = h('div', { class: 'actions' });
      listRow.append(button('Load models', 'small', async function () {
        var listed = await api('/api/provider-models', { choice: { id: o, baseUrl: fields.baseUrl && fields.baseUrl.value, apiKey: fields.apiKey.value } });
        fields.model.replaceChildren(); listed.models.forEach(function (m) { fields.model.append(h('option', { value: m, text: m })); });
      }, listRow));
      box.append(listRow);
    }
    if (id === 'brain') {
      if (o === 'acp') fields.command = textInput('["hermes","-p","voice","acp"]'), box.append(field('Command (JSON list of arguments)', fields.command));
      if (o === 'openai-compatible') { fields.baseUrl = textInput('', 'url'); fields.model = textInput(''); fields.apiKey = textInput('', 'password'); box.append(field('API base URL', fields.baseUrl), field('Model', fields.model), field('API key (optional)', fields.apiKey)); }
      else if (extra && picked === extra.key && o !== 'openai-compatible') { fields.model = textInput(o === 'ollama' ? 'qwen3.5:0.8b' : ''); box.append(field('Model', fields.model)); if (o !== 'ollama') { fields.apiKey = textInput('', 'password'); box.append(field('API key', fields.apiKey)); } }
      if (o === 'claude-code' && f.localTerminal) { fields.tab = h('input', { type: 'checkbox' }); box.append(h('label', { class: 'check-inline' }, [fields.tab, document.createTextNode('Type into my open Claude Code terminal tab instead of running it in the background')])); }
    }
    if (id === 'board' && o === 'paperclip' && !f.paperclipEnv) fields.companyId = textInput(''), box.append(field('Paperclip company ID (blank uses your paperclipai context)', fields.companyId));
    if ((id === 'stt' || id === 'tts') && o === 'wyoming') { fields.host = textInput('127.0.0.1'); fields.port = textInput(id === 'stt' ? '10300' : '10200', 'number'); box.append(field('Server host', fields.host), field('Port', fields.port)); }
    if (id === 'stt' && o === 'audiocpp') { fields.streaming = h('input', { type: 'checkbox' }); box.append(h('label', { class: 'check-inline' }, [fields.streaming, document.createTextNode('Stream browser speech for live captions (requires Nemotron mode: streaming)')])); }
    if (o === 'elevenlabs') fields.apiKey = textInput('', 'password'), box.append(field('ElevenLabs API key', fields.apiKey));
    if (fields.apiKey && state.storedSecrets && state.storedSecrets[id] && saved === o) fields.apiKey.parentNode.append(h('small', { text: 'A key is saved. Leave blank to keep it.' }));
    if (box.childNodes.length) detail.append(box);

    var s = stateLabel(o, f);
    var speechStatus = f.status && f.status[o];
    var guide = o === 'audiocpp' && speechStatus && speechStatus.installed ? null : GUIDES[o];
    if ((s && !s[1] && o !== 'none') || o === 'laya') {
      var panel = h('div', { class: 'panel warn' }, [h('h2', { text: optionName(id, o) + ': ' + (s ? s[0] : 'Checkpoint required') })]);
      if (guide) {
        var list = h('ol');
        guide.forEach(function (g) {
          var li = h('li', {}, [document.createTextNode(g[0])]);
          if (g[1] && g[1].indexOf('http') === 0) { li.append(document.createTextNode(': ')); li.append(h('a', { href: g[1], target: '_blank', rel: 'noopener noreferrer', text: g[1].replace(/^https?:[/][/]/, '') })); }
          else if (g[1]) li.append(cmd(g[1]));
          list.append(li);
        });
        panel.append(list);
      } else if ((id === 'stt' || id === 'tts') && o !== 'audiocpp') {
        panel.append(h('p', { text: 'You can pick it now. Cicero lists the install command on the Save screen.' }));
      }
      if (o === 'audiocpp') {
        var modelDir = id === 'stt' ? 'vendor/audio.cpp/models/nemotron-3.5-asr-streaming-0.6b' : 'vendor/audio.cpp/models/pocket-tts';
        if (!speechStatus.modelPresent) panel.append(h('p', { text: 'Model weights are installed manually. Put the ' + (id === 'stt' ? 'Nemotron' : 'Pocket TTS') + ' model in ' + modelDir + '. The build script does not download models.' }));
        else if (speechStatus.running && speechStatus.modelLoaded !== true) panel.append(h('p', { text: speechStatus.modelLoaded === null ? 'Port 8092 is reachable, but /v1/models could not be checked. Check the server and try again.' : 'Port 8092 is reachable, but /v1/models does not list ' + (id === 'stt' ? 'nemotron' : 'pocket-tts') + '. Check servers/audiocpp_server.local.json and restart the server.' }));
        panel.append(h('p', {}, [h('a', { href: 'https://github.com/5uck1ess/cicero/blob/main/docs/voice-cloning.md', target: '_blank', rel: 'noopener noreferrer', text: 'Read audio.cpp setup guidance' })]));
      }
      var again = h('div', { class: 'actions' });
      again.append(button('Check again', 'small', async function () { state = await api('/api/step', { id: id }); render(); }, again));
      panel.append(again);
      detail.append(panel);
    }
    var failed = blockedByProbe(state);
    if (failed && tried[id] === o) detail.append(h('div', { class: 'panel warn', role: 'alert' }, [h('h2', { text: 'That check failed' }), h('p', { text: failed }), h('p', { text: id === 'board' ? 'Fix the CLI and continue again, or choose No board.' : 'Fix it and continue again, or pick another option.' })]));
  }
  draw(); drawDetail();
  app.append(group, detail, why(step));
  var row = h('div', { class: 'actions' });
  row.append(button('Continue', 'primary', async function () {
    var c = { id: realId() };
    for (var k in fields) {
      var el = fields[k];
      if (k === 'tab') { if (el.checked) c.mode = 'tab-inject'; }
      else if (k === 'streaming') c.streaming = el.checked;
      else if (k === 'command') { try { c.command = JSON.parse(el.value); } catch (e) { throw new Error('The command must be a JSON list, like ["hermes","acp"].'); } }
      else if (k === 'port') c.port = Number(el.value);
      else if (k === 'apiKey' && !el.value) continue;
      else c[k] = el.value;
    }
    tried[id] = c.id;
    state = await api('/api/choice', { id: id, choice: c });
    if (blockedByProbe(state)) { render(); return; }
    await go(next(id));
  }, row));
  app.append(row);
}

function checkRow(check, kind) {
  var hint = check.hint || '';
  var command = hint;
  var looksLikeCmd = /^(uv|bun|cicero|ollama|brew|apt|sudo|pip|npm|scoop|winget)\\b/.test(command.trim());
  return h('li', { class: kind }, [
    h('div', { class: 'head' }, [h('span', { class: 'name', text: check.name })]),
    h('p', { class: 'detail', text: check.detail }),
    looksLikeCmd ? cmd(command.trim()) : (hint ? h('p', { class: 'detail', text: hint }) : null)
  ]);
}
function renderReview(step) {
  if (state.written) { renderDone(); return; }
  var g = state.checkGroups;
  if (!g) {
    var row0 = h('div', { class: 'actions' });
    row0.append(button('Run checks', 'primary', async function () { state = await api('/api/check', {}); render(); }, row0));
    app.append(row0); return;
  }
  var nReady = g.ok.length + g.warnings.length;
  app.append(h('div', { class: 'summary' }, [
    h('span', { class: 'pill ok', text: nReady + ' ready' }),
    g.notReady.length ? h('span', { class: 'pill todo', text: g.notReady.length + ' to install' }) : null,
    g.blocking.length ? h('span', { class: 'pill bad', text: g.blocking.length + ' to fix' }) : null
  ]));
  if (g.blocking.length) {
    app.append(h('h2', { class: 'section-h2', text: 'Fix before saving' }));
    var ul = h('ul', { class: 'rows' }); g.blocking.forEach(function (c) { ul.append(checkRow(c, 'blocking')); }); app.append(ul);
  }
  if (g.notReady.length) {
    app.append(h('h2', { class: 'section-h2', text: 'Install before starting Cicero' }),
      h('p', { class: 'note-line tight', text: 'You can save now and run these afterwards.' }));
    var ul2 = h('ul', { class: 'rows' }); g.notReady.forEach(function (c) { ul2.append(checkRow(c, 'notReady')); }); app.append(ul2);
  }
  var all = h('ul', { class: 'rows' });
  g.warnings.forEach(function (c) { all.append(checkRow(c, 'warn')); });
  g.ok.forEach(function (c) { all.append(checkRow(c, 'ok')); });
  app.append(h('details', { class: 'why' }, [h('summary', { text: 'Show everything that passed (' + nReady + ')' }), all]));
  app.append(h('details', { class: 'why' }, [h('summary', { text: 'Preview config.yaml' }), h('pre', { class: 'yaml', text: state.yaml })]));

  var ex = state.existing || {};
  if (ex.status === 'valid') app.append(h('div', { class: 'panel warn' }, [h('h2', { text: 'A config already exists' }), h('p', { text: 'Setup never overwrites it. Edit or move your current config.yaml, then run setup again.' })]));
  if (ex.status === 'other-file-error' || ex.status === 'unsafe') app.append(h('div', { class: 'panel warn' }, [h('h2', { text: 'Another Cicero file needs fixing' }), h('p', { text: ex.error })]));
  var row = h('div', { class: 'actions' });
  if (ex.status === 'invalid') {
    app.append(h('div', { class: 'panel warn' }, [h('h2', { text: 'Your current config.yaml has an error' }), h('p', { text: ex.error })]));
    row.append(button('Back up old config and start fresh', '', async function () { state = await api('/api/backup', {}); state = await api('/api/check', {}); render(); }, row));
  }
  app.append(why(step));
  var ack = null;
  if (state.requiresNotReadyAcknowledgement) {
    ack = h('input', { type: 'checkbox' });
    app.append(h('label', { class: 'check-inline' }, [ack, document.createTextNode('I\\u2019ll install the items above before starting Cicero.')]));
  }
  var save = button('Save config', 'primary', async function () {
    state = await api('/api/write', { acknowledgeNotReady: !!(ack && ack.checked) });
    render();
  }, row);
  save.disabled = !state.canWrite || !!ack;
  if (ack) ack.onchange = function () { save.disabled = !state.canWrite || !ack.checked; };
  row.append(save);
  app.append(row);
}
function renderDone() {
  var hd = state.handoff || {};
  app.append(h('div', { class: 'done-mark', 'aria-hidden': 'true', text: '\\u2713' }), h('h1', { text: 'Cicero is set up' }));
  if (hd.customHome) {
    app.append(h('p', { class: 'lede', text: 'This trial config was saved outside your Cicero home. Copy it there to use it.' }), cmd(hd.copyCommand), h('div', { class: 'spacer' }));
  } else {
    app.append(h('p', { class: 'lede', text: 'Start Cicero, then open web voice or pair your phone.' }));
  }
  app.append(h('div', { class: 'panel' }, [h('h2', { text: 'Start Cicero' }), cmd(state.startCommand)]),
    h('div', { class: 'panel' }, [h('h2', { text: 'Pair your phone' }), cmd('cicero pair')]));
  var row = h('div', { class: 'actions' });
  if (state.finished) app.append(h('p', { class: 'note-line tight', text: 'Setup has closed. You can close this tab.' }));
  else { row.append(button('Finish and close setup', 'primary', async function () { state = await api('/api/handoff', {}); render(); }, row)); app.append(row); }
}
function showFatal(e) { app.replaceChildren(h('h1', { text: 'Setup lost contact' }), h('p', { class: 'lede', text: e.message + ' If setup has finished or stopped, run cicero setup again.' })); }

function render() {
  app.replaceChildren();
  var toOverview = document.getElementById('to-overview');
  toOverview.hidden = view === 'overview';
  if (state.written && view !== 'overview') view = 'review';
  if (view === 'overview') { renderOverview(); return; }
  var serverId = view === 'review' ? 'check' : view;
  var step = state.steps.find(function (s) { return s.id === serverId; });
  app.append(chain(view));
  if (!(view === 'review' && state.written)) app.append(h('h1', { text: STEP[view].title }), h('p', { class: 'lede', text: STEP[view].lede }));
  if (view === 'system') renderSystem(step);
  else if (view === 'review') renderReview(step);
  else renderPicker(view, step);
}
document.getElementById('brand').onclick = function () { go('overview'); };
document.getElementById('to-overview').onclick = function () { go('overview'); };
function fromHash() { var id = location.hash.slice(1); return ORDER.indexOf(id) >= 0 ? id : 'overview'; }
window.onpopstate = function () { go(fromHash()).catch(showFatal); };
api('/api/state').then(function (s) {
  state = s;
  if (s.written) { view = 'review'; render(); return; }
  var start = fromHash();
  if (start === 'overview') render(); else return go(start);
}).catch(showFatal);
</script>
</body>
</html>`;
}
