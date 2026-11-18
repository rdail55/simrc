// Lightkey Web: open a Lightkey project in the browser, play its Live pages, and watch the result in a 2D
// preview or an MVR 3D scene.
import { readLightkey, unpackColor } from './lightkey.js';
import { Engine, segmentLook } from './engine.js';
import { readMvr, matchFixtures } from './mvr.js';
import { Stage2D } from './ui/stage2d.js';
import { Stage3D, virtualScene } from './ui/stage3d.js';
import { LivePanel } from './ui/live.js';
import { saveFile, getFile, listFiles, removeFile, getPref, setPref } from './store.js';
import { ProjectEditor } from './lkedit.js';
import { BuildPanel } from './ui/build.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
const RAD = 180 / Math.PI;

const app = {
  project: null, engine: null, live: null, stage2d: null, stage3d: null,
  scene: null, view: getPref('view', '2d'), selectedFixture: null, inspecting: null,
  bytes: null, canEdit: false, undoStack: [], dirty: false, build: null, side: getPref('side', 'build'),
};

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), ms);
}

// ---- opening files ------------------------------------------------------------------------------------------

async function openProject(bytes, name, { remember = true } = {}) {
  let project;
  try {
    project = readLightkey(bytes, name);
  } catch (err) {
    console.error(err);
    toast(`Couldn't read ${name}: ${err.message}`, 6000);
    return;
  }
  app.engine?.releaseAll(0);
  app.project = project;
  app.engine = new Engine(project);
  app.bytes = bytes;
  app.undoStack = [];
  app.dirty = !!(await getFile('project', name))?.edited && !remember;
  try { app.canEdit = new ProjectEditor(bytes).supported; } catch { app.canEdit = false; }
  updateSaveState();
  app.selectedFixture = null;
  app.scene = null;
  $('#welcome').classList.add('hidden');
  $('#main').classList.remove('hidden');
  $('#project-title').textContent = `${project.name}  ·  Lightkey ${project.appVersion}  ·  ${project.fixtures.length} fixtures`;
  document.title = `${project.name} – Lightkey Web`;

  app.stage2d ||= new Stage2D($('#view-2d'), { onSelect: (f) => (app.side === 'build' && f ? app.build.toggleFixture(f) : inspectFixture(f)) });
  app.stage2d.setProject(project);
  app.live = new LivePanel($('#live-panel'), app.engine, { onCueSelect: (c) => inspectCue(c), onRemove: (it) => removeButton(it) });
  app.build ||= new BuildPanel($('#build'), app);
  app.build.selection.clear();
  app.build.effects = [];
  app.stage2d.selection = app.build.selection;
  app.build.render();
  setSide(app.side);
  renderPageTabs();
  app.live.showPage(0);
  renderPalette();
  renderPatch();
  renderDmxGrid();
  $('#inspector').innerHTML = '<p class="muted">Click a cue, preset or fixture.</p>';
  app.engine.master = Number($('#master').value);
  app.engine.bpmSpeed = Number($('#speed').value);

  // Cues set to start with the show.
  for (const page of project.pages) for (const it of page.items) if (it.cue?.startup && page === app.live.page) app.engine.activateCue(it.cue, app.live.ctxFor(it));

  if (project.warnings.includes('legacy')) toast('Older Lightkey file (5.1 or earlier): converted for playback.');
  if (remember) {
    const prev = await getFile('project', name);
    await saveFile('project', name, bytes, { mvr: prev?.mvr || null, edited: false });
  }
  const rec = await getFile('project', name);
  if (rec?.mvr) {
    const m = await getFile('mvr', rec.mvr);
    if (m) await openMvr(m.bytes, m.name, { remember: false, quiet: true });
  }
  if (!app.scene && app.view === '3d') ensure3D();
  setView(app.view);
}

async function openMvr(bytes, name, { remember = true, quiet = false } = {}) {
  if (!app.project) { toast('Open a Lightkey project first, then the MVR.'); return; }
  $('#scene-info').textContent = `Loading ${name}…`;
  await new Promise((r) => setTimeout(r, 30));
  let scene;
  try {
    scene = readMvr(bytes, name);
  } catch (err) {
    console.error(err);
    toast(`Couldn't read ${name}: ${err.message}`, 6000);
    $('#scene-info').textContent = '';
    return;
  }
  const { matched, missing } = matchFixtures(scene, app.project);
  app.scene = scene;
  ensure3D(true);
  const info = `${name} · ${scene.generator || 'MVR'} · ${matched}/${app.project.fixtures.length} fixtures matched · ${(scene.stats.triangles / 1e6).toFixed(1)}M tris`;
  $('#scene-info').textContent = info;
  $('#scene-info').title = missing.length ? `Not in the MVR: ${missing.map((f) => f.name).join(', ')}` : 'Every fixture in the project is in the MVR';
  if (remember) {
    await saveFile('mvr', name, bytes);
    const rec = await getFile('project', app.project.fileName);
    if (rec) await saveFile('project', rec.name, rec.bytes, { mvr: name, edited: !!rec.edited });
  }
  if (!quiet) { toast(`3D scene loaded: ${matched} of ${app.project.fixtures.length} fixtures matched by address.`); setView('3d'); }
}

function ensure3D(rebuild = false) {
  if (!app.project) return;
  app.stage3d ||= new Stage3D($('#view-3d'));
  if (rebuild || !app.stage3d.data || (app.stage3d.data.virtual && app.scene) || app.stage3d.forProject !== app.project.fileName) {
    app.stage3d.forProject = app.project.fileName;
    const data = app.scene || virtualScene(app.project);
    app.stage3d.build(data);
    if (!app.scene) $('#scene-info').textContent = 'No MVR loaded: fixtures hung from the Lightkey stage layout. Open an MVR for the real room.';
  }
  app.stage3d.haze = Number($('#haze').value);
  app.stage3d.setHouse(Number($('#house').value));
}

// ---- editing --------------------------------------------------------------------------------------------------

/** Apply an edit to the project file: fn(editor, project) changes the archive; the result is re-read so the
 *  whole app shows exactly what was written. Returns fn's result, or null if it failed. */
function applyEdit(fn) {
  if (!app.canEdit) { toast('This project can only be viewed (saved by an older Lightkey).'); return null; }
  let result, bytes;
  try {
    const ed = new ProjectEditor(app.bytes);
    result = fn(ed, app.project) ?? true;
    bytes = ed.bytes();
    readLightkey(bytes, app.project.fileName); // must read back before we accept it
  } catch (err) {
    console.error(err);
    toast(`Couldn't make that change: ${err.message}`, 6000);
    return null;
  }
  app.undoStack.push(app.bytes);
  if (app.undoStack.length > 30) app.undoStack.shift();
  reloadBytes(bytes);
  return result;
}

function reloadBytes(bytes) {
  const project = readLightkey(bytes, app.project.fileName);
  app.bytes = bytes;
  app.project = project;
  app.engine.setProject(project);
  if (app.scene) matchFixtures(app.scene, project);
  else if (app.stage3d?.data?.virtual) for (const sf of app.stage3d.data.fixtures) sf.fixture = project.fixtureById.get(sf.fixture?.uuid) || null;
  app.stage2d.project = project;
  const pi = Math.min(app.live.pageIndex, project.pages.length - 1);
  app.live.pageIndex = Math.max(0, pi);
  app.live.render();
  renderPageTabs();
  renderPalette();
  renderPatch();
  renderDmxGrid();
  app.build.updatePreview();
  app.build.renderWrite();
  app.dirty = true;
  updateSaveState();
  saveFile('project', project.fileName, bytes, { mvr: app.scene?.fileName || null, edited: true });
}

function undo() {
  const prev = app.undoStack.pop();
  if (!prev) { toast('Nothing to undo.'); return; }
  reloadBytes(prev);
  toast('Undone.');
}

function removeButton(item) {
  if (!app.canEdit) return;
  if (!confirm(`Remove “${item.cue.name}” from the page “${app.live.page.name}”?\n(Its preset stays in the Palette.)`)) return;
  app.engine.releaseCue(item.cue, 0);
  applyEdit((ed) => {
    const panel = ed.panelByUUID(app.live.page.uuid);
    if (!panel || !ed.removeFromPage(panel.obj, item.cue.uuid)) throw new Error('Button not found');
  });
}

function updateSaveState() {
  $('#save').classList.toggle('dirty', !!app.dirty);
  $('#save').disabled = !app.project;
  $('#undo').disabled = !app.undoStack.length;
}

async function saveProject() {
  if (!app.bytes) return;
  const base = app.project.name.replace(/ \(Lightkey Web\)$/, '');
  const suggested = `${base} (Lightkey Web).lightkeyproj`;
  const blob = new Blob([app.bytes], { type: 'application/octet-stream' });
  try {
    if (window.showSaveFilePicker) {
      const h = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'Lightkey project', accept: { 'application/octet-stream': ['.lightkeyproj'] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Saved ${h.name}. Open it in Lightkey (quit Lightkey first if the project is open there).`, 6000);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = suggested;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Downloaded ${suggested}.`, 5000);
    }
    app.dirty = false;
    updateSaveState();
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Couldn't save: ${err.message}`, 6000);
  }
}

function setSide(which) {
  app.side = which;
  setPref('side', which);
  for (const b of document.querySelectorAll('#side-tabs button')) b.classList.toggle('on', b.dataset.side === which);
  $('#build').classList.toggle('hidden', which !== 'build');
  $('#inspector').classList.toggle('hidden', which !== 'inspect');
  if (app.stage2d) app.stage2d.selection = which === 'build' ? app.build?.selection : null;
}

function showPage(i) { app.live.showPage(i); renderPageTabs(); app.build?.renderWrite(); }
app.applyEdit = applyEdit;
app.toast = toast;
app.showPage = showPage;

async function openFiles(files) {
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.mvr$/i.test(f.name)) await openMvr(bytes, f.name);
    else if (/\.lightkeyproj$/i.test(f.name)) await openProject(bytes, f.name);
    else toast(`${f.name}: not a .lightkeyproj or .mvr file`);
  }
}

// ---- views --------------------------------------------------------------------------------------------------

function setView(v) {
  app.view = v;
  setPref('view', v);
  for (const b of document.querySelectorAll('#view-tabs button')) b.classList.toggle('on', b.dataset.view === v);
  for (const k of ['2d', '3d', 'patch', 'dmx']) $(`#view-${k}`).classList.toggle('on', k === v);
  $('#opts-3d').classList.toggle('on', v === '3d');
  if (v === '3d') ensure3D();
  if (app.stage3d) app.stage3d.active = v === '3d';
  if (app.stage2d) app.stage2d.active = v === '2d';
  if (v === '3d') app.stage3d?.resize();
}

function renderPageTabs() {
  const tabs = $('#page-tabs');
  tabs.innerHTML = '';
  app.project.pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.title = `Priority ${p.priority} · page fade ${p.fade}s${i < 9 ? ` · key ${i + 1}` : ''}`;
    b.onclick = () => showPage(i);
    if (i === app.live?.pageIndex) b.classList.add('on');
    tabs.appendChild(b);
  });
}

// ---- palette ------------------------------------------------------------------------------------------------

function presetSwatch(preset) {
  for (const uc of Object.values(preset.containers)) {
    const c = uc.segmentContainers?.[0]?.color?.[0];
    if (c != null && uc.definedFeatures?.includes('Color')) return hex(unpackColor(c));
  }
  const fx = preset.effects.find((e) => e.feature === 'Color' && e.params.values?.[0]?.rgb);
  return fx ? hex(fx.params.values[0].rgb) : null;
}

function renderPalette() {
  const root = $('#palette-tree');
  const filter = $('#palette-search').value.trim().toLowerCase();
  root.innerHTML = '';
  const openGroups = new Set(getPref('openGroups', []));
  function build(node, parent, siblings) {
    if (node.type === 'preset') {
      if (filter && !node.preset.name.toLowerCase().includes(filter)) return false;
      const el = document.createElement('div');
      el.className = 'preset';
      const sw = presetSwatch(node.preset);
      el.innerHTML = `<span class="sw" style="background:${sw || 'transparent'};${sw ? '' : 'border-color:transparent'}"></span><span class="nm"></span>${node.preset.effects.length ? `<span class="fxbadge">FX ${node.preset.effects.length}</span>` : ''}`;
      el.querySelector('.nm').textContent = node.preset.name;
      el.dataset.uuid = node.preset.uuid;
      el.onclick = () => {
        const on = !app.engine.isPresetActive(node.preset);
        if (on && siblings?.exclusive) for (const s of siblings.children) if (s.type === 'preset' && s !== node) app.engine.togglePreset(s.preset, false);
        app.engine.togglePreset(node.preset, on);
        inspectPreset(node.preset);
      };
      parent.appendChild(el);
      return true;
    }
    const det = document.createElement('details');
    const key = node.uuid || node.name;
    det.open = !!filter || openGroups.has(key) || node === app.project.palette;
    det.innerHTML = `<summary></summary><div class="children"></div>`;
    det.querySelector('summary').innerHTML = `${esc(node.name)}${node.exclusive ? '<span class="excl" title="Presets in this folder are mutually exclusive">excl</span>' : ''}`;
    det.addEventListener('toggle', () => {
      const s = new Set(getPref('openGroups', []));
      det.open ? s.add(key) : s.delete(key);
      setPref('openGroups', [...s]);
    });
    let any = false;
    for (const c of node.children) any = build(c, det.querySelector('.children'), node) || any;
    if (node === app.project.palette) { for (const c of [...det.querySelector('.children').childNodes]) root.appendChild(c); return any; }
    if (any || !filter) parent.appendChild(det);
    return any;
  }
  build(app.project.palette, root, null);
  if (!root.childNodes.length) root.innerHTML = '<p class="muted" style="padding:10px">No presets.</p>';
}

function refreshPalette() {
  for (const el of document.querySelectorAll('#palette-tree .preset')) {
    const p = app.project.presets.get(el.dataset.uuid);
    el.classList.toggle('on', !!p && app.engine.isPresetActive(p));
  }
}

// ---- inspector ----------------------------------------------------------------------------------------------

function fixturesOf(preset) {
  const ids = new Set([...Object.keys(preset.containers), ...preset.effects.flatMap((e) => e.extent)]);
  return [...ids].map((id) => app.project.fixtureById.get(id)).filter(Boolean);
}

const EFFECT_NAMES = { 1000: 'Pattern', 2000: 'Movement path', 3000: 'Curve', 6000: 'Spread' };

function inspectCue(cue) {
  app.inspecting = { cue };
  const fixtures = new Set(cue.presets.flatMap(fixturesOf));
  $('#inspector').innerHTML = `
    <h3>${esc(cue.name)}</h3>
    <table>
      <tr><td>Fade in / out</td><td>${cue.fadeIn}s / ${cue.fadeOut}s</td></tr>
      <tr><td>Priority</td><td>${cue.priority}</td></tr>
      <tr><td>Intensity</td><td>${Math.round(cue.intensity * 100)}%</td></tr>
      ${cue.speed !== 1 ? `<tr><td>Speed</td><td>${cue.speed}×</td></tr>` : ''}
      <tr><td>Fixtures</td><td>${fixtures.size}</td></tr>
    </table>
    <p class="muted small" style="margin:10px 0 4px">Presets</p>
    <div>${cue.presets.map((p) => `<span class="chip click" data-p="${p.uuid}">${esc(p.name)}</span>`).join('') || '<span class="muted">none</span>'}</div>`;
  for (const ch of $('#inspector').querySelectorAll('[data-p]')) ch.onclick = () => inspectPreset(app.project.presets.get(ch.dataset.p));
}

function inspectPreset(preset) {
  app.inspecting = { preset };
  const fx = fixturesOf(preset);
  const feats = new Set(Object.values(preset.containers).flatMap((c) => c.definedFeatures || []).map((f) => (f.startsWith('custom--') ? 'Custom' : f)));
  $('#inspector').innerHTML = `
    <h3>${esc(preset.name)}</h3>
    <table>
      <tr><td>Properties</td><td>${[...feats].map((f) => `<span class="chip">${esc(f)}</span>`).join('') || '—'}</td></tr>
      <tr><td>Effects</td><td>${preset.effects.map((e) => `<span class="chip">${esc(e.feature)} · ${EFFECT_NAMES[e.cls] || e.cls}${e.params.duration ? ` · ${e.params.duration}s` : ''}</span>`).join('') || '—'}</td></tr>
      <tr><td>Fixtures (${fx.length})</td><td>${fx.map((f) => `<span class="chip click" data-f="${f.index}">${esc(f.name)}</span>`).join('')}</td></tr>
    </table>`;
  for (const ch of $('#inspector').querySelectorAll('[data-f]')) ch.onclick = () => inspectFixture(app.project.fixtures[Number(ch.dataset.f)]);
}

function inspectFixture(f) {
  app.selectedFixture = f;
  if (app.stage2d) app.stage2d.selected = f;
  if (!f) { app.inspecting = null; $('#inspector').innerHTML = '<p class="muted">Click a cue, preset or fixture.</p>'; return; }
  app.inspecting = { fixture: f };
  $('#inspector').innerHTML = `
    <h3>${esc(f.name)}</h3>
    <table>
      <tr><td>Fixture</td><td>${esc(f.profile.manufacturer)} ${esc(f.profile.name)}</td></tr>
      <tr><td>Mode</td><td>${esc(f.per?.name)} (${f.footprint} ch)</td></tr>
      <tr><td>Address</td><td>Universe ${f.universe} · ${f.address}–${f.address + f.footprint - 1}</td></tr>
    </table>
    <p class="muted small" style="margin:10px 0 4px">Live output</p>
    <table id="fx-live"></table>`;
  updateFixtureInspector();
}

function updateFixtureInspector() {
  const f = app.inspecting?.fixture;
  const tbl = $('#fx-live');
  if (!f || !tbl) return;
  const st = app.engine.states[f.index];
  const now = performance.now();
  const rows = [];
  st.seg.forEach((s, i) => {
    const look = segmentLook(f, s, st, now);
    rows.push(`<tr><td>${st.seg.length > 1 ? `Cell ${i + 1}` : 'Intensity'}</td><td><span class="chip" style="background:${hex(look.rgb.map((v) => v * Math.max(0.25, look.b)))}">&nbsp;&nbsp;</span> ${Math.round(s.intensity * 100)}%${s.shutter === 0 ? ' · closed' : s.shutter >= 2 ? ' · strobe' : ''}</td></tr>`);
  });
  if (f.per?.hasPanTilt) rows.push(`<tr><td>Pan / tilt</td><td>${(st.pan * RAD).toFixed(0)}° / ${(st.tilt * RAD).toFixed(0)}°</td></tr>`);
  if (st.zoomAngle != null) rows.push(`<tr><td>Zoom</td><td>${st.zoomAngle.toFixed(1)}°</td></tr>`);
  if (st.gobo[0] || st.gobo[1]) rows.push(`<tr><td>Gobo</td><td>${esc([st.gobo[0], st.gobo[1]].filter(Boolean).join(', '))}</td></tr>`);
  if (f.profile.kind === 'fog') rows.push(`<tr><td>Fog</td><td>${Math.round(st.fog * 100)}%</td></tr>`);
  const buf = app.engine.dmx.get(f.universe);
  if (buf && f.per) {
    rows.push(`<tr><td colspan="2" class="muted small" style="padding-top:8px">DMX</td></tr>`);
    for (const c of f.per.channels) rows.push(`<tr><td>${f.address + c.index} · ${esc(c.name || c.attr)}</td><td>${buf[f.address - 1 + c.index]}</td></tr>`);
  }
  tbl.innerHTML = rows.join('');
}

// ---- patch + DMX ----------------------------------------------------------------------------------------------

function renderPatch() {
  const p = app.project;
  const rows = [...p.fixtures].sort((a, b) => a.universe - b.universe || a.address - b.address).map((f) => `
    <tr data-f="${f.index}"><td><span class="sw" data-sw="${f.index}"></span></td><td>${esc(f.name)}</td><td>${esc(f.profile.manufacturer)} ${esc(f.profile.name)}</td>
    <td>${esc(f.per?.name || '')}</td><td>${f.universe}</td><td>${f.address}</td><td>${f.footprint}</td><td>${f.stage ? '✓' : ''}</td></tr>`).join('');
  const unis = p.universes.map((u) => `Universe ${u.index}${u.device ? ` → ${esc(u.device)}` : ''}`).join(' · ');
  $('#view-patch').innerHTML = `<p class="muted">${unis}</p><table class="patch"><thead><tr><th></th><th>Name</th><th>Fixture</th><th>Mode</th><th>Uni</th><th>Addr</th><th>Ch</th><th>On stage</th></tr></thead><tbody>${rows}</tbody></table>`;
  for (const tr of $('#view-patch').querySelectorAll('tr[data-f]')) tr.onclick = () => inspectFixture(p.fixtures[Number(tr.dataset.f)]);
}

function renderDmxGrid() {
  const p = app.project;
  const starts = new Map();
  for (const f of p.fixtures) starts.set(`${f.universe}:${f.address}`, f.name);
  $('#view-dmx').innerHTML = p.universes.map((u) => `
    <div class="dmx-uni"><h4>Universe ${u.index} <span class="muted small">${esc(u.device)}</span></h4>
    <div class="dmx-grid" data-u="${u.index}">${Array.from({ length: 512 }, (_, i) => {
      const nm = starts.get(`${u.index}:${i + 1}`);
      return `<div class="dmx-cell${nm ? ' start' : ''}"${nm ? ` title="${esc(nm)}"` : ''}><div class="bar"></div><span class="n">${i + 1}</span><span class="v">0</span></div>`;
    }).join('')}</div></div>`).join('');
}

function refreshDmx() {
  for (const grid of document.querySelectorAll('.dmx-grid')) {
    const buf = app.engine.dmx.get(Number(grid.dataset.u));
    if (!buf) continue;
    const cells = grid.children;
    for (let i = 0; i < 512; i++) {
      const v = buf[i];
      const c = cells[i];
      if (c._v === v) continue;
      c._v = v;
      c.lastChild.textContent = v;
      c.firstChild.style.height = `${(v / 255) * 100}%`;
    }
  }
}

function refreshPatchSwatches() {
  const now = performance.now();
  for (const el of document.querySelectorAll('#view-patch [data-sw]')) {
    const f = app.project.fixtures[Number(el.dataset.sw)];
    const st = app.engine.states[f.index];
    const look = segmentLook(f, st.seg[0], st, now);
    el.style.background = hex(look.rgb.map((v) => v * look.b));
  }
}

// ---- main loop --------------------------------------------------------------------------------------------

let lastSlow = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (!app.engine) return;
  const states = app.engine.tick(now);
  app.build?.tick();
  if (app.stage2d) { app.stage2d.states = states; app.stage2d.render(); }
  if (app.stage3d) app.stage3d.states = states;
  if (now - lastSlow > 100) {
    lastSlow = now;
    app.live.refresh();
    refreshPalette();
    if (app.view === 'dmx') refreshDmx();
    if (app.view === 'patch') refreshPatchSwatches();
    if (app.inspecting?.fixture) updateFixtureInspector();
  }
}
requestAnimationFrame(loop);

// ---- wiring -----------------------------------------------------------------------------------------------

$('#open-project').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
$('#open-mvr').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
for (const b of document.querySelectorAll('#view-tabs button')) b.onclick = () => setView(b.dataset.view);
for (const b of document.querySelectorAll('[data-cam]')) b.onclick = () => app.stage3d?.frame(b.dataset.cam);
$('#haze').oninput = (e) => { if (app.stage3d) app.stage3d.haze = Number(e.target.value); };
$('#house').oninput = (e) => app.stage3d?.setHouse(Number(e.target.value));
$('#master').oninput = (e) => { if (app.engine) app.engine.master = Number(e.target.value); };
$('#speed').oninput = (e) => { $('#speed-out').textContent = `${Number(e.target.value).toFixed(2)}×`; if (app.engine) app.engine.bpmSpeed = Number(e.target.value); };
$('#release').onclick = () => app.engine?.releaseAll(1);
$('#blackout').onclick = () => {
  if (!app.engine) return;
  app.engine.blackout = !app.engine.blackout;
  $('#blackout').classList.toggle('on', app.engine.blackout);
};
$('#palette-search').oninput = () => app.project && renderPalette();
$('#save').onclick = saveProject;
$('#undo').onclick = undo;
for (const b of document.querySelectorAll('#side-tabs button')) b.onclick = () => setSide(b.dataset.side);
addEventListener('beforeunload', (e) => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });

// Drag and drop anywhere.
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop-overlay').classList.add('on'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop-overlay').classList.remove('on'); openFiles([...e.dataTransfer.files]); });

// Keys: Esc release all, B blackout, Space GO on this page's first cuelist, 1–9 pages.
addEventListener('keydown', (e) => {
  if (!app.engine || e.target?.matches?.('input[type=search], input[type=text], input[type=number]')) return;
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveProject(); return; }
  if (e.metaKey || e.ctrlKey) return;
  if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) return;
  if (e.key === 'Escape') app.engine.releaseAll(1);
  else if ((e.key === 't' || e.key === 'T') && app.side === 'build') document.querySelector('#tap')?.click();
  else if (e.key === 'b' || e.key === 'B') $('#blackout').click();
  else if (e.key === ' ') {
    const list = app.live.page?.items.find((i) => i.kind === 'cuelist');
    if (list) { e.preventDefault(); app.live.go(list, e.shiftKey ? -1 : 1); }
  } else if (/^[1-9]$/.test(e.key) && app.project.pages[Number(e.key) - 1]) showPage(Number(e.key) - 1);
});

// Splitter between the preview and the Live pages.
{
  const split = $('#splitter');
  const vp = document.querySelector('.viewport'), live = document.querySelector('.live');
  const apply = (frac) => { vp.style.flex = `${frac} 1 0`; live.style.flex = `${1 - frac} 1 0`; };
  apply(getPref('split', 0.55));
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const box = document.querySelector('.center').getBoundingClientRect();
    const move = (ev) => {
      const frac = Math.max(0.15, Math.min(0.85, (ev.clientY - box.top - 40) / (box.height - 40)));
      apply(frac);
      setPref('split', frac);
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', () => split.removeEventListener('pointermove', move), { once: true });
  });
}

// Welcome: recent projects stored in this browser.
async function renderRecent() {
  const list = await listFiles('project');
  const el = $('#recent');
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<p class="muted small">Recent</p>' + list.slice(0, 8).map((f) => `
    <div class="item" data-n="${esc(f.name)}"><span>${esc(f.name.replace(/\.lightkeyproj$/i, ''))}</span>${f.mvr ? '<span class="muted small">+ 3D</span>' : ''}<small>${new Date(f.savedAt).toLocaleDateString()}</small><button class="x" title="Forget">✕</button></div>`).join('');
  for (const it of el.querySelectorAll('.item')) {
    it.onclick = async (e) => {
      if (e.target.classList.contains('x')) { e.stopPropagation(); await removeFile('project', it.dataset.n); renderRecent(); return; }
      const rec = await getFile('project', it.dataset.n);
      if (rec) openProject(rec.bytes, rec.name, { remember: false });
    };
  }
}
renderRecent();
setView(app.view);

// Debugging from the console: lkweb.open(bytes, 'Name.lightkeyproj' | 'Scene.mvr')
app.open = (bytes, name) => (/\.mvr$/i.test(name) ? openMvr(bytes, name) : openProject(bytes, name));
window.lkweb = app;
