import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import './style.css';

const app = document.querySelector('#app');
const state = { videos: [], rows: [], source: '', sourcePath: '', output: '', customOutput: false, busy: false };

app.innerHTML = `
  <header class="topbar"><div class="brand"><div class="brand-mark">▶</div><div><strong>Video GIF Studio</strong><small>Offline batch converter</small></div></div><span class="local-tag">Runs locally on your computer</span></header>
  <main>
    <section class="hero"><div><p class="eyebrow">MP4 → GIF</p><h1>Make every GIF fit.</h1><p>Choose a video or folder, set the look, then measure actual output sizes before saving.</p></div><div class="hero-actions"><button id="add-files" class="primary">Add MP4 files</button><button id="add-folder" class="secondary">Choose folder</button></div></section>
    <div class="layout"><aside class="panel settings"><div class="panel-heading"><h2>Conversion settings</h2><span>Apply to all videos</span></div>
      <div class="field-grid"><label>Frame rate (FPS)<input id="fps" type="number" min="1" max="60" value="12"></label><label>Maximum size (MB)<input id="limit" type="number" min="0.1" step="0.1" value="25"></label></div>
      <div class="field-grid"><label>Width (px)<input id="width" type="number" min="1" value="480"></label><label>Height (px)<input id="height" type="number" min="1" value="270"></label></div>
      <div class="field-grid"><label>Aspect ratio<select id="aspect"><option value="source">Keep source</option><option>1:1</option><option>4:3</option><option>16:9</option><option>9:16</option></select></label><label>Colors<select id="colors"><option>256</option><option>192</option><option>128</option><option>64</option><option>32</option></select></label></div>
      <h3>Clip range</h3><div class="field-grid"><label>Start (seconds)<input id="start" type="number" min="0" step="0.1" value="0"></label><label>Duration (seconds)<input id="duration" type="number" min="0" step="0.1" value="8"><small>0 uses the rest of each video</small></label></div>
      <details><summary>Crop coordinates</summary><p class="hint">Leave width and height at 0 for no crop.</p><div class="field-grid"><label>X<input id="crop-x" type="number" min="0" value="0"></label><label>Y<input id="crop-y" type="number" min="0" value="0"></label><label>Crop width<input id="crop-width" type="number" min="0" value="0"></label><label>Crop height<input id="crop-height" type="number" min="0" value="0"></label></div></details>
      <h3>Size limit behavior</h3><label class="radio"><input type="radio" name="mode" value="adjust" checked><span><strong>Adjust to fit</strong><small>Reduce colors, dimensions, then FPS only for oversized GIFs.</small></span></label><label class="radio"><input type="radio" name="mode" value="keep"><span><strong>Keep my settings</strong><small>Show measured sizes without changing settings.</small></span></label><label class="check"><input id="skip" type="checkbox" checked>Skip GIFs above the size limit when saving</label>
      <h3>Output</h3><div class="output-line"><div id="output-path" class="path">Choose videos to set a default folder</div><button id="choose-output" class="text-button">Change</button></div>
    </aside>
    <section class="panel results"><div class="panel-heading"><div><h2>Videos <span id="video-count" class="count">0</span></h2><p id="source-line">No videos selected</p></div><button id="clear" class="text-button">Clear</button></div>
      <div class="summary"><div><strong id="within-count">0</strong><span>Within limit</span></div><div><strong id="above-count">0</strong><span>Above limit</span></div><div><strong id="within-percent">—</strong><span>Within limit</span></div><div><strong id="above-percent">—</strong><span>Above limit</span></div></div>
      <div id="empty" class="empty"><div class="empty-icon">▧</div><h3>Your videos will appear here</h3><p>Select MP4 files or a folder to get started.</p></div>
      <div id="table-wrap" class="table-wrap hidden"><table><thead><tr><th>Video</th><th>Source</th><th>GIF size</th><th>Output settings</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table></div>
      <div id="progress-wrap" class="progress-wrap hidden"><div class="progress-label"><span id="progress-text">Evaluating</span><span id="progress-numbers"></span></div><div class="progress-track"><div id="progress-fill"></div></div></div>
      <div id="message" class="message" role="status"></div>
      <div class="footer-actions"><button id="cancel" class="secondary hidden">Cancel</button><button id="evaluate" class="secondary" disabled>Evaluate sizes</button><button id="save" class="primary" disabled>Save GIFs</button></div>
    </section></div>
  </main>`;

const $ = (id) => document.getElementById(id);
const settingsFields = ['fps','limit','width','height','aspect','colors','start','duration','crop-x','crop-y','crop-width','crop-height','skip'];
const bytes = (n) => `${(n / 1_000_000).toFixed(2)} MB`;
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

function settings() {
  return {
    fps: +$('fps').value, limitMb: +$('limit').value, width: +$('width').value,
    height: +$('height').value, aspect: $('aspect').value, colors: +$('colors').value,
    start: +$('start').value, duration: +$('duration').value,
    cropX: +$('crop-x').value, cropY: +$('crop-y').value,
    cropWidth: +$('crop-width').value, cropHeight: +$('crop-height').value,
    mode: selectedMode(), skipOversize: $('skip').checked
  };
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function defaultOutput() {
  if (!state.videos.length || state.customOutput) return;
  const path = state.sourcePath || state.videos[0].path;
  const separator = path.includes('\\') ? '\\' : '/';
  const parent = path.slice(0, path.lastIndexOf(separator));
  const duration = +$('duration').value ? `${+$('duration').value}s` : 'full';
  state.output = `${parent}${separator}video-gif-${+$('fps').value}fps-${duration}`;
  $('output-path').textContent = state.output;
}

function render() {
  $('video-count').textContent = state.videos.length;
  $('source-line').textContent = state.source || 'No videos selected';
  $('empty').classList.toggle('hidden', state.videos.length > 0);
  $('table-wrap').classList.toggle('hidden', state.videos.length === 0);
  $('evaluate').disabled = !state.videos.length || state.busy;
  $('save').disabled = !state.rows.length || state.busy || !state.rows.some(r => !r.error && (!$('skip').checked || r.withinLimit));
  const within = state.rows.filter(r => r.withinLimit).length;
  const above = state.rows.filter(r => !r.withinLimit && !r.error).length;
  $('within-count').textContent = within;
  $('above-count').textContent = above;
  $('within-percent').textContent = state.rows.length ? `${Math.round(within / state.rows.length * 100)}%` : '—';
  $('above-percent').textContent = state.rows.length ? `${Math.round(above / state.rows.length * 100)}%` : '—';
  $('rows').innerHTML = state.videos.map(video => {
    const row = state.rows.find(r => r.path === video.path);
    const size = row ? (row.error ? '—' : bytes(row.sizeBytes)) : 'Not evaluated';
    const status = row ? (row.error ? 'Error' : row.withinLimit ? 'Within limit' : 'Above limit') : 'Pending';
    const cls = row ? (row.error ? 'bad' : row.withinLimit ? 'good' : 'bad') : 'pending';
    const output = row ? `${row.effectiveFps} fps · ${row.effectiveWidth}×${row.effectiveHeight} · ${row.effectiveColors} colors` : '—';
    return `<tr><td><strong title="${escapeHtml(video.path)}">${escapeHtml(video.name)}</strong>${row?.error ? `<small class="row-error" title="${escapeHtml(row.error)}">${escapeHtml(row.error)}</small>` : ''}</td><td>${video.duration.toFixed(1)}s · ${video.width}×${video.height}</td><td>${size}</td><td>${output}</td><td><span class="badge ${cls}">${status}</span></td></tr>`;
  }).join('');
}

function invalidate() { state.rows = []; defaultOutput(); render(); message(state.videos.length ? 'Settings changed. Evaluate sizes again.' : ''); }
settingsFields.forEach(id => $(id).addEventListener('change', id === 'skip' ? render : invalidate));
document.querySelectorAll('input[name="mode"]').forEach(el => el.addEventListener('change', invalidate));

async function select(directory) {
  try {
    const paths = await open({ directory, multiple: !directory, filters: directory ? undefined : [{ name: 'MP4 video', extensions: ['mp4'] }] });
    if (!paths) return;
    const selected = Array.isArray(paths) ? paths : [paths];
    state.videos = await invoke('scan', { paths: selected });
    state.rows = []; state.source = selected.length === 1 ? selected[0] : `${selected.length} selected files`; state.sourcePath = directory ? selected[0] : state.videos[0].path;
    state.customOutput = false; defaultOutput(); render(); message(`${state.videos.length} video${state.videos.length === 1 ? '' : 's'} ready to evaluate.`);
  } catch (error) { message(String(error), true); }
}
$('add-files').onclick = () => select(false);
$('add-folder').onclick = () => select(true);
$('clear').onclick = () => { state.videos = []; state.rows = []; state.source = ''; state.sourcePath = ''; state.output = ''; state.customOutput = false; $('output-path').textContent = 'Choose videos to set a default folder'; render(); message(''); };
$('choose-output').onclick = async () => { const path = await open({ directory: true, multiple: false }); if (path) { state.output = path; state.customOutput = true; $('output-path').textContent = path; } };

function busy(value) { state.busy = value; $('cancel').classList.toggle('hidden', !value); render(); }
$('cancel').onclick = async () => { await invoke('cancel'); message('Stopping after the current file finishes…'); };
$('evaluate').onclick = async () => {
  const s = settings();
  if (!Number.isInteger(s.fps) || s.fps < 1 || s.fps > 60 || s.width < 1 || s.height < 1 || s.colors < 2 || s.limitMb <= 0 || s.start < 0 || s.duration < 0) { message('Check FPS, size limit, dimensions, colors, and clip range.', true); return; }
  busy(true); state.rows = []; $('progress-wrap').classList.remove('hidden'); message('Encoding temporary GIFs to measure their actual sizes.');
  try { state.rows = await invoke('evaluate', { videos: state.videos, settings: s }); message(`Evaluation finished: ${state.rows.length} of ${state.videos.length} videos measured.`); }
  catch (error) { message(String(error), true); }
  finally { busy(false); $('progress-wrap').classList.add('hidden'); }
};
$('save').onclick = async () => {
  if (!state.output) { message('Choose an output folder.', true); return; }
  busy(true); $('progress-wrap').classList.remove('hidden'); message('Saving evaluated GIFs.');
  try { const count = await invoke('export', { rows: state.rows, outputDir: state.output, skipOversize: $('skip').checked }); message(`Saved ${count} GIF${count === 1 ? '' : 's'} to ${state.output}`); }
  catch (error) { message(String(error), true); }
  finally { busy(false); $('progress-wrap').classList.add('hidden'); }
};

listen('job-progress', event => {
  const p = event.payload;
  $('progress-text').textContent = `${p.phase === 'saving' ? 'Saving' : 'Evaluating'}: ${p.current}`;
  $('progress-numbers').textContent = `${p.completed} / ${p.total}`;
  $('progress-fill').style.width = `${p.total ? p.completed / p.total * 100 : 0}%`;
});
render();
