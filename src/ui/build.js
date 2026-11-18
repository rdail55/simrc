// Build panel: make a look from built-in, tempo-aware effects and write it to a Live page.
//   Tempo   – type a BPM, tap it, or analyse a song (and play it with the preview locked to its beat grid).
//   Fixtures – stage groups or click fixtures in the Preview.
//   Look    – intensity, colour, position, zoom.
//   Effects – from the library, in beats and bars. They follow the tempo while you build.
//   Write   – a cue button on a Live page; effect durations are fixed in seconds at the current tempo,
//             so the written button no longer changes when the tempo does.
import { EFFECTS, RATES, ORDERS, SIZES, compileLook, secondsFor, can } from '../looks.js';
import { decodeStoreBytes } from '../lightkey.js';
import { analyseTempo, Tapper, SongPlayer } from '../tempo.js';
import { newUUID } from '../lkedit.js';
import { getPref, setPref } from '../store.js';

const SWATCHES = [
  ['White', [1, 1, 1]], ['Warm', [1, 0.78, 0.5]], ['Gold', [1, 0.65, 0.12]], ['Amber', [1, 0.45, 0]], ['Red', [1, 0, 0]],
  ['Magenta', [1, 0, 0.6]], ['Pink', [1, 0.35, 0.7]], ['Violet', [0.55, 0, 1]], ['Blue', [0, 0.1, 1]], ['Sky', [0.25, 0.6, 1]],
  ['Cyan', [0, 0.9, 1]], ['Teal', [0, 0.8, 0.55]], ['Green', [0, 1, 0.1]],
];
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const swatchName = (rgb) => SWATCHES.find(([, c]) => c.every((v, i) => Math.abs(v - rgb[i]) < 0.01))?.[0] || hex(rgb);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RAD = 180 / Math.PI;

export class BuildPanel {
  constructor(container, app) {
    this.el = container;
    this.app = app;
    this.song = new SongPlayer();
    this.tapper = new Tapper();
    this.bpm = getPref('bpm', 120);
    this.downbeat = 0;
    this.selection = new Set();
    this.look = { intensity: 1, color: null, position: null, zoom: null };
    this.effects = [];
    this.effectColors = [[1, 0, 0], [0, 0.1, 1]];
    this.start = performance.now();
    this.pathIds = new Map(); // preview path ids per effect key (stable while building)
    this.lastBeat = -1;
  }

  get project() { return this.app.project; }
  get fixtures() { return this.project.fixtures.filter((f) => this.selection.has(f.uuid)); }

  // ---- programmer (live preview) ---------------------------------------------------------------------------

  lookSpec() {
    return { fixtures: this.fixtures, ...this.look, effects: this.effects };
  }

  /** Compile the look exactly as it would be written and show it on top of everything. */
  updatePreview() {
    const eng = this.app.engine;
    if (!eng) return;
    if (!this.selection.size || (!this.effects.length && this.look.intensity == null && !this.look.color && !this.look.position && this.look.zoom == null)) {
      eng.setProgrammer(null);
      this.renderSummary([]);
      return;
    }
    const ids = [];
    const c = compileLook(this.lookSpec(), this.bpm, () => { const k = ids.length; ids.push(k); const key = `p${k}`; if (!this.pathIds.has(key)) this.pathIds.set(key, `preview.${newUUID()}`); return this.pathIds.get(key); });
    for (const p of c.paths) this.project.movementPaths.set(p.id, { name: p.name, smooth: true, points: p.points });
    eng.setProgrammer(decodeStoreBytes(c.bytes), this.start);
    this.renderSummary(c.summary);
  }

  /** Lock the effect clock to the song's bar grid while it plays (so a pulse lands on the beat). */
  alignToSong() {
    if (!this.song.playing) return;
    const bar = (240 / this.bpm);
    const t = this.song.time;
    const lastBar = this.downbeat + Math.floor((t - this.downbeat) / bar) * bar;
    this.start = this.song.perfTimeOf(lastBar);
    this.updatePreview();
  }

  clear() {
    this.selection.clear();
    this.look = { intensity: 1, color: null, position: null, zoom: null };
    this.effects = [];
    this.app.stage2d.selection = this.selection;
    this.updatePreview();
    this.render();
  }

  // ---- fixture selection -------------------------------------------------------------------------------------

  toggleFixture(f) {
    if (this.selection.has(f.uuid)) this.selection.delete(f.uuid); else this.selection.add(f.uuid);
    this.afterSelection();
  }

  selectSet(list, add = false) {
    if (!add) this.selection.clear();
    for (const f of list) this.selection.add(f.uuid);
    this.afterSelection();
  }

  afterSelection() {
    this.app.stage2d.selection = this.selection;
    this.updatePreview();
    this.renderFixtures();
    this.renderLook();
    this.renderEffects();
  }

  groups() {
    const p = this.project;
    const out = [];
    const all = p.fixtures.filter((f) => f.per);
    const movers = all.filter(can.pantilt);
    const colour = all.filter((f) => f.per.hasColor && !f.per.hasPanTilt);
    if (all.length) out.push(['All', all]);
    if (movers.length) out.push(['Movers', movers]);
    if (colour.length) out.push(['Colour washes', colour]);
    const byProfile = new Map();
    for (const f of all) {
      const k = f.profile.name;
      if (!byProfile.has(k)) byProfile.set(k, []);
      byProfile.get(k).push(f);
    }
    if (byProfile.size > 1) for (const [k, list] of byProfile) out.push([`${k} (${list.length})`, list]);
    p.stage.groups.forEach((g, i) => { if (g.length > 1) out.push([`Stage group ${i + 1}: ${g.slice(0, 3).map((f) => f.name).join(' ')}${g.length > 3 ? '…' : ''}`, g]); });
    return out;
  }

  // ---- tempo -----------------------------------------------------------------------------------------------

  setBpm(v) {
    const b = Math.max(40, Math.min(240, Math.round(Number(v) * 10) / 10));
    if (!Number.isFinite(b)) return;
    this.bpm = b;
    setPref('bpm', b);
    this.el.querySelector('#bpm').value = b;
    this.alignToSong();
    this.updatePreview();
    this.renderEffects();
  }

  async loadSong(file) {
    const status = this.el.querySelector('#song-status');
    status.textContent = `Analysing ${file.name}…`;
    try {
      const buf = await this.song.load(file);
      await new Promise((r) => setTimeout(r, 20));
      const r = analyseTempo(buf);
      this.downbeat = r.downbeat;
      this.setBpm(r.bpm);
      status.textContent = `${file.name} · ${r.bpm} BPM · first downbeat ${r.downbeat.toFixed(2)}s`;
      this.el.querySelector('#song-play').disabled = false;
      this.el.querySelector('#song-stop').disabled = false;
    } catch (err) {
      status.textContent = `Couldn't read ${file.name}: ${err.message}`;
    }
  }

  /** Called every frame: beat light and song position. */
  tick() {
    const dot = this.el.querySelector('#beat-dot');
    if (!dot) return;
    let beat;
    if (this.song.playing) beat = Math.floor((this.song.time - this.downbeat) / (60 / this.bpm));
    else beat = Math.floor((performance.now() - this.start) / (60000 / this.bpm));
    if (beat !== this.lastBeat) {
      this.lastBeat = beat;
      dot.classList.remove('on', 'one');
      void dot.offsetWidth;
      dot.classList.add('on');
      if (((beat % 4) + 4) % 4 === 0) dot.classList.add('one');
      dot.textContent = ((beat % 4) + 4) % 4 + 1;
    }
    if (this.song.buffer) {
      const t = this.song.time;
      this.el.querySelector('#song-time').textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} / ${Math.floor(this.song.buffer.duration / 60)}:${String(Math.floor(this.song.buffer.duration % 60)).padStart(2, '0')}`;
      const pos = this.el.querySelector('#song-pos');
      if (!pos.matches(':active')) pos.value = t / this.song.buffer.duration;
    }
  }

  // ---- writing ---------------------------------------------------------------------------------------------

  autoName() {
    const parts = this.effects.map((e) => EFFECTS.find((d) => d.id === e.id)?.name);
    if (this.look.color) parts.push(swatchName(this.look.color));
    if (!parts.length && this.look.intensity != null) parts.push(`${Math.round(this.look.intensity * 100)}%`);
    return `${parts.join(' ') || 'Look'} ${Math.round(this.bpm)}`;
  }

  write() {
    const name = this.el.querySelector('#w-name').value.trim() || this.autoName();
    const pageSel = this.el.querySelector('#w-page').value;
    const fade = Math.max(0, Number(this.el.querySelector('#w-fade').value) || 0);
    const flash = this.el.querySelector('#w-flash').checked;
    let newPageName = null;
    if (pageSel === '__new') {
      newPageName = prompt('Name for the new Live page', this.song.name ? this.song.name.replace(/\.[^.]+$/, '') : 'Song');
      if (!newPageName) return;
    }
    const spec = this.lookSpec();
    if (!spec.fixtures.length) { this.app.toast('Select some fixtures first.'); return; }
    const bpm = this.bpm;
    const ok = this.app.applyEdit((ed, project) => {
      const c = compileLook(spec, bpm, () => `user.${newUUID()}`);
      for (const p of c.paths) ed.addMovementPath(p.name, p.points, true, p.id);
      const preset = ed.makePreset(name, c.bytes);
      ed.items(ed.ourFolder().childNodes).push(preset.uid);
      const cue = ed.makeCue(name, [preset.uid], { fadeIn: fade, fadeOut: fade });
      const panel = newPageName ? ed.addPage(newPageName).obj : ed.panelByUUID(pageSel)?.obj;
      if (!panel) throw new Error('That Live page no longer exists.');
      const [w, h] = ed.defaultButtonSize();
      const rect = this.freeSlot(newPageName ? null : project.pages.find((p) => p.uuid === pageSel), w, h);
      ed.addToPage(panel, ed.makeButton(cue.uid, rect, { flash }).uid);
      return { pageName: newPageName || project.pages.find((p) => p.uuid === pageSel)?.name, summary: c.summary };
    });
    if (ok) {
      this.app.toast(`Added “${name}” to ${ok.pageName}. ${ok.summary.join(' · ')}`, 5000);
      const idx = this.app.project.pages.findIndex((p) => p.name === ok.pageName);
      if (idx >= 0 && idx !== this.app.live.pageIndex) this.app.showPage(idx);
      this.el.querySelector('#w-name').value = '';
      this.renderWrite();
    }
  }

  /** Next free spot on a page: continue the bottom row, or start a new row under everything. */
  freeSlot(page, w, h) {
    const items = (page?.items || []).filter((i) => i.rect && !i.frame);
    if (!items.length) return { x: 5, y: 7, w, h };
    const bottom = Math.max(...items.map((i) => i.rect.y));
    const row = items.filter((i) => Math.abs(i.rect.y - bottom) < h * 0.5);
    const right = Math.max(...row.map((i) => i.rect.x + i.rect.w));
    if (right + w + 5 < 1100) return { x: right + 5, y: bottom, w, h };
    const maxY = Math.max(...items.map((i) => i.rect.y + i.rect.h));
    return { x: 5, y: maxY + 10, w, h };
  }

  // ---- rendering -------------------------------------------------------------------------------------------

  render() {
    const p = this.project;
    if (!p) { this.el.innerHTML = '<p class="muted">Open a project first.</p>'; return; }
    if (!this.app.canEdit) {
      this.el.innerHTML = `<p class="muted">This project was saved by Lightkey ${esc(p.appVersion)}. Building needs a project saved by Lightkey 5.7 or newer: open it in Lightkey, save it, and open it here again.</p>`;
      return;
    }
    this.el.innerHTML = `
      <section class="b-sec">
        <h4>Tempo</h4>
        <div class="row">
          <input id="bpm" type="number" min="40" max="240" step="0.1" value="${this.bpm}"> <span class="muted">BPM</span>
          <button id="tap" title="Tap on the beat (T)">Tap</button>
          <button id="half" title="Half tempo">÷2</button><button id="double" title="Double tempo">×2</button>
          <span id="beat-dot" class="beat-dot">1</span>
        </div>
        <div class="row">
          <label class="btn small">Analyse song…<input id="song-file" type="file" accept="audio/*" hidden></label>
          <button id="song-play" disabled>▶︎</button><button id="song-stop" disabled>■</button>
          <span id="song-time" class="muted small"></span>
        </div>
        <input id="song-pos" type="range" min="0" max="1" step="0.0005" value="0" class="wide">
        <div id="song-status" class="muted small">${this.song.name ? esc(this.song.name) : 'Or type the BPM. Effects below follow it.'}</div>
      </section>
      <section class="b-sec"><h4>Fixtures <span id="sel-count" class="muted"></span></h4><div id="b-fixtures"></div></section>
      <section class="b-sec"><h4>Look</h4><div id="b-look"></div></section>
      <section class="b-sec"><h4>Effects</h4><div id="b-effects"></div></section>
      <section class="b-sec"><h4>Add to Live page</h4><div id="b-write"></div></section>`;

    const $ = (s) => this.el.querySelector(s);
    $('#bpm').onchange = (e) => this.setBpm(e.target.value);
    $('#tap').onclick = () => { const b = this.tapper.tap(); if (b) this.setBpm(b); };
    $('#half').onclick = () => this.setBpm(this.bpm / 2);
    $('#double').onclick = () => this.setBpm(this.bpm * 2);
    $('#song-file').onchange = (e) => { if (e.target.files[0]) this.loadSong(e.target.files[0]); e.target.value = ''; };
    $('#song-play').onclick = () => {
      if (this.song.playing) { this.song.pause(); $('#song-play').textContent = '▶︎'; }
      else { this.song.play(); $('#song-play').textContent = '❚❚'; this.alignToSong(); }
    };
    $('#song-stop').onclick = () => { this.song.stop(); $('#song-play').textContent = '▶︎'; };
    $('#song-pos').oninput = (e) => { if (this.song.buffer) { this.song.seek(Number(e.target.value) * this.song.buffer.duration); this.alignToSong(); } };
    if (this.song.buffer) { $('#song-play').disabled = false; $('#song-stop').disabled = false; $('#song-play').textContent = this.song.playing ? '❚❚' : '▶︎'; }
    this.renderFixtures();
    this.renderLook();
    this.renderEffects();
    this.renderWrite();
  }

  renderFixtures() {
    const box = this.el.querySelector('#b-fixtures');
    if (!box) return;
    this.el.querySelector('#sel-count').textContent = this.selection.size ? `· ${this.selection.size} selected` : '';
    const groups = this.groups();
    const chip = ([n], i) => `<button class="chip-btn" data-g="${i}">${esc(n)}</button>`;
    const stage = groups.map((g, i) => [g, i]).filter(([g]) => g[0].startsWith('Stage group'));
    const main = groups.map((g, i) => [g, i]).filter(([g]) => !g[0].startsWith('Stage group'));
    box.innerHTML = `<div class="chips">${main.map(([g, i]) => chip(g, i)).join('')}<button class="chip-btn" data-g="none">None</button></div>
      ${stage.length ? `<details class="more-groups"><summary class="muted small">Stage groups (${stage.length})</summary><div class="chips">${stage.map(([g, i]) => chip(g, i)).join('')}</div></details>` : ''}
      <p class="muted small">Click fixtures in the Preview to add or remove them. Shift-click a group to add it.</p>`;
    for (const b of box.querySelectorAll('[data-g]')) {
      b.onclick = (e) => {
        if (b.dataset.g === 'none') { this.selection.clear(); this.afterSelection(); return; }
        this.selectSet(groups[Number(b.dataset.g)][1], e.shiftKey);
      };
    }
  }

  renderLook() {
    const box = this.el.querySelector('#b-look');
    if (!box) return;
    const sel = this.fixtures;
    const hasMovers = sel.some(can.pantilt), hasZoom = sel.some(can.zoom);
    const L = this.look;
    box.innerHTML = `
      <label class="row"><input type="checkbox" id="l-int" ${L.intensity != null ? 'checked' : ''}> Intensity
        <input type="range" id="l-int-v" min="0" max="1" step="0.01" value="${L.intensity ?? 1}" ${L.intensity == null ? 'disabled' : ''}>
        <span class="muted small" id="l-int-o">${L.intensity != null ? Math.round(L.intensity * 100) + '%' : 'not set'}</span></label>
      <div class="row wrap">Colour
        <span class="sw-row">${[['None', null], ...SWATCHES].map(([n, c]) => `<button class="sw ${(c === null ? !L.color : L.color && c.every((v, i) => v === L.color[i])) ? 'on' : ''}" title="${n}" data-c='${c ? JSON.stringify(c) : 'null'}' style="background:${c ? hex(c) : 'transparent'}">${c ? '' : '∅'}</button>`).join('')}
        <input type="color" id="l-col" value="${L.color ? hex(L.color) : '#ffffff'}" title="Custom colour"></span></div>
      ${hasMovers ? `
      <label class="row"><input type="checkbox" id="l-pos" ${L.position ? 'checked' : ''}> Position
        <button id="l-pos-cur" class="small" title="Take the movers' current position from the stage">Use current</button></label>
      <div class="row ${L.position ? '' : 'dim'}">Pan <input type="range" id="l-pan" min="-180" max="180" step="1" value="${L.position?.pan ?? 0}"> <span id="l-pan-o" class="muted small">${Math.round(L.position?.pan ?? 0)}°</span></div>
      <div class="row ${L.position ? '' : 'dim'}">Tilt <input type="range" id="l-tilt" min="-135" max="135" step="1" value="${L.position?.tilt ?? 30}"> <span id="l-tilt-o" class="muted small">${Math.round(L.position?.tilt ?? 30)}°</span></div>` : ''}
      ${hasZoom ? `<label class="row"><input type="checkbox" id="l-zoom" ${L.zoom != null ? 'checked' : ''}> Zoom <input type="range" id="l-zoom-v" min="0" max="1" step="0.01" value="${L.zoom ?? 0.5}" ${L.zoom == null ? 'disabled' : ''}> <span class="muted small">narrow → wide</span></label>` : ''}`;
    const $ = (s) => box.querySelector(s);
    $('#l-int').onchange = (e) => { L.intensity = e.target.checked ? Number($('#l-int-v').value) : null; this.renderLook(); this.updatePreview(); };
    $('#l-int-v').oninput = (e) => { L.intensity = Number(e.target.value); $('#l-int-o').textContent = `${Math.round(L.intensity * 100)}%`; this.updatePreview(); };
    for (const b of box.querySelectorAll('.sw')) b.onclick = () => { L.color = JSON.parse(b.dataset.c); this.renderLook(); this.updatePreview(); };
    $('#l-col').oninput = (e) => { L.color = fromHex(e.target.value); this.updatePreview(); };
    $('#l-col').onchange = () => this.renderLook();
    if (hasMovers) {
      const setPos = () => { L.position = { pan: Number($('#l-pan').value), tilt: Number($('#l-tilt').value) }; $('#l-pan-o').textContent = `${L.position.pan}°`; $('#l-tilt-o').textContent = `${L.position.tilt}°`; this.updatePreview(); };
      $('#l-pos').onchange = (e) => { if (e.target.checked) setPos(); else { L.position = null; this.updatePreview(); } this.renderLook(); };
      $('#l-pan').oninput = () => { if (!$('#l-pos').checked) $('#l-pos').checked = true; setPos(); };
      $('#l-tilt').oninput = () => { if (!$('#l-pos').checked) $('#l-pos').checked = true; setPos(); };
      $('#l-pos-cur').onclick = () => {
        const movers = sel.filter(can.pantilt);
        const sts = movers.map((f) => this.app.engine.states[f.index]);
        const pan = sts.reduce((a, s) => a + s.pan, 0) / sts.length * RAD, tilt = sts.reduce((a, s) => a + s.tilt, 0) / sts.length * RAD;
        L.position = { pan: Math.round(pan), tilt: Math.round(tilt) };
        this.renderLook();
        this.updatePreview();
      };
    }
    if (hasZoom) {
      $('#l-zoom').onchange = (e) => { L.zoom = e.target.checked ? Number($('#l-zoom-v').value) : null; this.renderLook(); this.updatePreview(); };
      $('#l-zoom-v').oninput = (e) => { L.zoom = Number(e.target.value); this.updatePreview(); };
    }
  }

  renderEffects() {
    const box = this.el.querySelector('#b-effects');
    if (!box) return;
    const sel = this.fixtures;
    const usable = (d) => sel.some((f) => (d.needs ? can[d.needs](f) : can.intensity(f)));
    const groups = [...new Set(EFFECTS.map((d) => d.group))];
    const active = this.effects.map((e, i) => {
      const d = EFFECTS.find((x) => x.id === e.id);
      const secs = secondsFor(e.rate, this.bpm);
      return `<div class="fx-card">
        <div class="fx-head"><b>${esc(d.name)}</b><span class="muted small">${secs.toFixed(2)}s at ${this.bpm} BPM</span><button class="x" data-rm="${i}" title="Remove">✕</button></div>
        <div class="row wrap">
          <select data-k="rate" data-i="${i}">${RATES.map((r) => `<option value="${r.id}" ${r.id === e.rate ? 'selected' : ''}>${r.label}</option>`).join('')}</select>
          ${d.make !== 'path' || d.spread || d.half ? `<select data-k="order" data-i="${i}">${ORDERS.map((o) => `<option value="${o.id}" ${o.id === e.order ? 'selected' : ''}>${o.label}</option>`).join('')}</select>` : ''}
          ${d.make === 'path' ? `<select data-k="size" data-i="${i}">${Object.keys(SIZES).map((s) => `<option value="${s}" ${s === e.size ? 'selected' : ''}>${{ s: 'Small', m: 'Medium', l: 'Large' }[s]} (${SIZES[s]}°)</option>`).join('')}</select>` : ''}
        </div>
        ${d.make === 'chase' ? `<div class="row wrap">Colours <span class="sw-row">${SWATCHES.map(([n, c]) => { const k = e.colors.findIndex((x) => x.every((v, j) => v === c[j])); return `<button class="sw ${k >= 0 ? 'on' : ''}" title="${n}" data-i="${i}" data-ec='${JSON.stringify(c)}' style="background:${hex(c)}">${k >= 0 ? k + 1 : ''}</button>`; }).join('')}</span></div>` : ''}
      </div>`;
    }).join('');
    box.innerHTML = `${active || '<p class="muted small">No effects. Add one below. Intensity, colour, movement and beam effects can be combined (one of each).</p>'}
      <div class="fx-lib">${groups.map((g) => `<div class="fx-group"><div class="muted small">${g}</div>${EFFECTS.filter((d) => d.group === g).map((d) => `<button class="fx-add" data-add="${d.id}" title="${esc(d.desc)}" ${usable(d) ? '' : 'disabled'}>${esc(d.name)}</button>`).join('')}</div>`).join('')}</div>
      ${sel.length ? '' : '<p class="muted small">Select fixtures to enable effects.</p>'}`;
    for (const b of box.querySelectorAll('[data-add]')) {
      b.onclick = () => {
        const d = EFFECTS.find((x) => x.id === b.dataset.add);
        // One effect per property: a new intensity effect replaces the old one, etc.
        this.effects = this.effects.filter((e) => EFFECTS.find((x) => x.id === e.id).feature !== d.feature);
        this.effects.push({ id: d.id, rate: d.rate, order: d.order, size: 'm', colors: this.effectColors.map((c) => [...c]) });
        if (d.feature === 'PanTilt' && !this.look.position) this.look.position = { pan: 0, tilt: 30 };
        this.renderLook();
        this.renderEffects();
        this.updatePreview();
      };
    }
    for (const b of box.querySelectorAll('[data-rm]')) b.onclick = () => { this.effects.splice(Number(b.dataset.rm), 1); this.renderEffects(); this.updatePreview(); };
    for (const s of box.querySelectorAll('select[data-k]')) s.onchange = () => { this.effects[Number(s.dataset.i)][s.dataset.k] = s.value; this.renderEffects(); this.updatePreview(); };
    for (const b of box.querySelectorAll('[data-ec]')) {
      b.onclick = () => {
        const e = this.effects[Number(b.dataset.i)];
        const c = JSON.parse(b.dataset.ec);
        const k = e.colors.findIndex((x) => x.every((v, j) => v === c[j]));
        if (k >= 0) { if (e.colors.length > 1) e.colors.splice(k, 1); } else if (e.colors.length < 6) e.colors.push(c);
        this.effectColors = e.colors.map((x) => [...x]);
        this.renderEffects();
        this.updatePreview();
      };
    }
  }

  renderWrite() {
    const box = this.el.querySelector('#b-write');
    if (!box) return;
    const pages = this.project.pages;
    const cur = this.app.live?.page?.uuid;
    box.innerHTML = `
      <div class="row"><input id="w-name" type="text" placeholder="${esc(this.autoName())}" class="grow"></div>
      <div class="row">Page <select id="w-page" class="grow">${pages.map((p) => `<option value="${p.uuid}" ${p.uuid === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">New page…</option></select></div>
      <div class="row">Fade <input id="w-fade" type="number" min="0" step="0.1" value="${getPref('fade', 0.5)}" style="width:60px">s
        <label><input type="checkbox" id="w-flash"> Flash button</label></div>
      <div class="row"><button id="w-add" class="primary grow">Add to Live page</button><button id="w-clear" title="Clear the selection, look and effects">Clear</button></div>
      <p class="muted small">Effect times are fixed when you add the button, so later tempo changes won't affect it.</p>
      <div id="w-summary" class="muted small"></div>`;
    box.querySelector('#w-add').onclick = () => this.write();
    box.querySelector('#w-clear').onclick = () => this.clear();
    box.querySelector('#w-fade').onchange = (e) => setPref('fade', Number(e.target.value));
    box.querySelector('#w-name').placeholder = this.autoName();
  }

  renderSummary(lines) {
    const s = this.el.querySelector('#w-summary');
    if (s) s.textContent = lines.length ? `Will write: ${lines.join(' · ')}` : '';
    const n = this.el.querySelector('#w-name');
    if (n) n.placeholder = this.autoName();
  }
}
