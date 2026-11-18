// Stage Vis: a Capture-style visualiser in the browser. The room and rig come from an MVR; fixtures can be placed,
// moved and patched; they're driven live by Art-Net / sACN on any number of universes (Lightkey, Arena…), the
// PixelStix sit on the back wall from the Stix Arranger layout, and the projector screen shows an NDI source.
// Live inputs come from the bridge in Arena Practice (rig-sim-bridge.py), because browsers can't receive UDP.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Stage3D } from '../ui/stage3d.js';
import { readMvr } from '../mvr.js';
import { readLightkey } from '../lightkey.js';
import { readGdtf } from '../gdtf.js';
import { readDMX } from '../dmxread.js';
import { saveFile, listFiles, getFile } from '../store.js';
import { unzipSync } from 'fflate';
import { Bridge } from './bridge.js';
import { Stix, PIXELS, stickPatch } from './stix.js';

const $ = (s) => document.querySelector(s);
const FT = 304.8;
const SAVE_KEY = 'stagevis.layout.v1';
const HOSTED = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
// The screen in River Church MVR.mvr (found from its geometry): MVR millimetres, Z up, audience towards −Y.
const DEFAULT_SCREEN = { left: -2214, right: 2211, bottom: 3245, top: 5874, face: -450 };

const S = {
  mvr: null,          // MVR file name
  fixtures: [],       // { id, name, type, mode, universe (1-based), address (1-based), matrix[12] mm }
  stix: { on: true, universe: 11, depth: 0, glow: 1 },
  screen: { ...DEFAULT_SCREEN, on: true, ndi: '', hq: false },
  haze: 0.6, house: 0.25,
};
try { Object.assign(S, JSON.parse(localStorage.getItem(SAVE_KEY) || '{}')); } catch { /* storage unavailable */ }
let saveTimer = 0;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch {} }, 300); };

const lib = new Map();      // type id → { id, label, profile, source }
let scene = null;           // parsed MVR
let project = null;         // Lightkey project (for profiles + missing fixtures)
let stixLayout = null;
const bridge = new Bridge();

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, ms);
}

// ---------- fixture library ----------
function generic(id, label, attrs, extra = {}) {
  const channels = attrs.map((a, i) => ({ index: i, attr: a, name: a, segment: null, settings: [{ from: 0, to: 255 }],
    ...(a === 'strobe' ? { ranges: [{ from: 0, to: 9, kind: 'open' }, { from: 10, to: 255, kind: 'strobe' }] } : {}),
    ...(a === 'zoom' ? { minAngle: 8, maxAngle: 40 } : {}) }));
  const has = new Set(attrs);
  const per = { index: 0, name: `${attrs.length}ch`, footprint: attrs.length, channels, segments: 1, has,
    hasColor: has.has('red'), hasPanTilt: has.has('pan'), zoom: channels.find((c) => c.attr === 'zoom') };
  lib.set(id, { id, label, source: 'Generic', profile: { uuid: id, name: label, manufacturer: 'Generic', kind: has.has('pan') ? 'mover' : has.has('red') ? 'color' : 'other', panRange: 540, tiltRange: 270, tiltCenter: 0, beamSpread: extra.beam || 25, personalities: [per] } });
}
generic('gen:dimmer', 'Generic dimmer (1ch)', ['dim'], { beam: 26 });
generic('gen:rgb', 'Generic RGB (3ch)', ['red', 'green', 'blue'], { beam: 30 });
generic('gen:drgb', 'Generic dim+RGB (4ch)', ['dim', 'red', 'green', 'blue'], { beam: 30 });
generic('gen:rgbw', 'Generic RGBW (4ch)', ['red', 'green', 'blue', 'white'], { beam: 30 });
generic('gen:mover', 'Generic mover (pan, tilt, dim, RGB, zoom)', ['pan', 'panFine', 'tilt', 'tiltFine', 'dim', 'red', 'green', 'blue', 'zoom'], { beam: 14 });

function addProfile(id, profile, source) {
  lib.set(id, { id, label: `${profile.manufacturer ? `${profile.manufacturer} ` : ''}${profile.name}`, profile, source });
}

function useProject(p, name) {
  project = p;
  for (const f of p.fixtures) if (!lib.has(`lk:${f.profile.uuid}`)) addProfile(`lk:${f.profile.uuid}`, f.profile, `Lightkey: ${name}`);
  // Give fixtures that only have a placeholder/generic type the Lightkey profile patched at the same address.
  let n = 0;
  const byAddr = new Map(p.fixtures.map((f) => [`${f.universe}:${f.address}`, f]));
  for (const f of S.fixtures) {
    const cur = lib.get(f.type);
    if (cur && cur.source !== 'Generic' && !cur.profile.placeholder) continue;
    const m = byAddr.get(`${f.universe}:${f.address}`);
    if (m) { f.type = `lk:${m.profile.uuid}`; f.mode = m.per.index; f.lkName = m.name; n++; }
  }
  return n;
}

function useGdtf(bytes, name) {
  const prof = readGdtf(bytes, name);
  if (prof.placeholder) {
    // Capture's stand-in GDTFs: channels are just numbered; treat channel 1 as intensity so the light still shows.
    for (const per of prof.personalities) if (per.channels[0]) { per.channels[0].attr = 'dim'; per.has = new Set(per.channels.map((c) => c.attr)); }
    prof.kind = 'other';
  }
  addProfile(`gdtf:${prof.uuid}`, prof, prof.placeholder ? 'MVR placeholder' : `GDTF: ${name}`);
  return prof;
}

// ---------- 3D ----------
const stage = new Stage3D($('#view'));
stage.active = true;
const stix = new Stix(stage.world);
const tc = new TransformControls(stage.camera, stage.renderer.domElement);
tc.setSize(0.8);
stage.scene.add(tc.getHelper());
tc.addEventListener('dragging-changed', (e) => { stage.controls.enabled = !e.value; if (!e.value) commitTransform(); });
tc.addEventListener('objectChange', () => { if (selected) syncMatrix(selected); renderInspector(true); });

let screenMesh = null, screenTex = null, lastFrameSeq = -1;
function buildScreen() {
  if (screenMesh) { stage.world.remove(screenMesh); screenMesh.geometry.dispose(); screenMesh.material.dispose(); screenMesh = null; }
  const sc = S.screen;
  if (!sc.on) return;
  const w = sc.right - sc.left, h = sc.top - sc.bottom;
  const g = new THREE.PlaneGeometry(w, h).rotateX(Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x15161a, toneMapped: false, side: THREE.DoubleSide });
  screenMesh = new THREE.Mesh(g, mat);
  screenMesh.position.set((sc.left + sc.right) / 2, sc.face - 8, (sc.bottom + sc.top) / 2);
  stage.world.add(screenMesh);
  screenTex = null; lastFrameSeq = -1;
}

function updateScreen() {
  const f = bridge.frame;
  if (!screenMesh || !f || !S.screen.ndi || f.seq === lastFrameSeq) return;
  lastFrameSeq = f.seq;
  if (!screenTex || screenTex.image.width !== f.w || screenTex.image.height !== f.h) {
    screenTex?.dispose();
    screenTex = new THREE.DataTexture(f.data, f.w, f.h, THREE.RGBAFormat);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    screenTex.repeat.set(1, -1); screenTex.offset.set(0, 1); // NDI rows run top-down
    screenTex.magFilter = THREE.LinearFilter; screenTex.minFilter = THREE.LinearFilter;
    screenMesh.material.map = screenTex; screenMesh.material.color.set(0xffffff); screenMesh.material.needsUpdate = true;
  } else screenTex.image.data = f.data;
  screenTex.needsUpdate = true;
}

function buildStix() {
  if (!stixLayout || !S.stix.on) { stix.build({ layout: { sticks: [] }, screen: {} }); return; }
  const sc = S.screen;
  stix.build({ layout: stixLayout, screen: { cx: (sc.left + sc.right) / 2, bottom: sc.bottom, face: sc.face }, depth: S.stix.depth });
}

// Records the 3D stage draws: one per placed fixture, with a live-state handle.
let records = [];
function sceneData() {
  const base = scene || { meshes: [], instances: [], bounds: { min: [-8000, -8000, 0], max: [8000, 8000, 6000] }, fixtures: [] };
  return { ...base, fixtures: records.map((r) => r.sf) };
}

function recordFor(f, i) {
  const t = lib.get(f.type) || lib.get('gen:dimmer');
  const per = t.profile.personalities[f.mode || 0] || t.profile.personalities[0];
  const sf = { name: f.name, matrix: f.matrix, beamAngle: t.profile.beamAngle || t.profile.beamSpread || undefined, fixture: { index: i, name: f.name, profile: t.profile, per, stage: null } };
  return { f, sf, profile: t.profile, per };
}

function rebuildAll() {
  records = S.fixtures.map(recordFor);
  stage.build(sceneData());
  for (const fx of stage.fixtures) prepare(fx);
  buildScreen();
  buildStix();
  stage.setHouse(S.house); stage.haze = S.haze;
  states = new Array(records.length);
  selected = null; tc.detach();
  renderList(); renderInspector(); renderInputs();
}

function prepare(fx) {
  fx.root.matrix.decompose(fx.root.position, fx.root.quaternion, fx.root.scale);
  fx.root.matrixAutoUpdate = true;
  fx.root.userData.fx = fx;
}

function syncMatrix(fx) {
  fx.root.updateMatrix();
  const e = fx.root.matrix.elements;
  const m = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]].map((v) => Math.round(v * 1e4) / 1e4);
  fx.sf.matrix = m;
  records.find((r) => r.sf === fx.sf).f.matrix = m;
}

function commitTransform() { save(); renderInspector(); }

// ---------- live DMX ----------
let states = [];
function liveStates() {
  records.forEach((r, i) => {
    const { f, profile, per } = r;
    states[i] = readDMX((ch) => bridge.get(f.universe, f.address - 1 + ch), profile, per);
  });
  stage.states = states;
  if (stixLayout && S.stix.on) {
    stix.update((i, k) => {
      const p = stickPatch(i), u = S.stix.universe + p.uniOffset, c = p.address - 1 + k * 3;
      return [bridge.get(u, c), bridge.get(u, c + 1), bridge.get(u, c + 2)];
    }, S.stix.glow);
  }
}

// Stage3D draws in its own animation loop; refresh live state just before each render.
const baseRender = stage.render.bind(stage);
stage.render = () => { liveStates(); updateScreen(); baseRender(); };

// ---------- selection & placing ----------
let selected = null, placing = false;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pointer(ev) {
  const r = stage.renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, stage.camera);
}
let down = null;
stage.renderer.domElement.addEventListener('pointerdown', (ev) => { down = [ev.clientX, ev.clientY]; });
stage.renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4 || ev.button !== 0 || tc.dragging || tc.axis) return;
  pointer(ev);
  if (placing) return placeAt();
  const bodies = stage.fixtures.map((fx) => fx.head.children[0]);
  const hit = ray.intersectObjects(bodies, false)[0];
  select(hit ? stage.fixtures.find((fx) => fx.head.children[0] === hit.object) : null);
});

function select(fx) {
  selected = fx || null;
  if (selected) tc.attach(selected.root); else tc.detach();
  renderList(); renderInspector(); showTab('fixture');
}

function nextAddress(universe, footprint) {
  const used = S.fixtures.filter((f) => f.universe === universe).map((f) => {
    const t = lib.get(f.type); const per = t?.profile.personalities[f.mode || 0];
    return [f.address, f.address + (per?.footprint || 1) - 1];
  });
  // Lightkey's patch too, so a new light doesn't land on a fixture that isn't placed yet.
  for (const f of project?.fixtures || []) if (f.universe === universe) used.push([f.address, f.address + (f.footprint || 1) - 1]);
  used.sort((a, b) => a[0] - b[0]);
  let a = 1;
  for (const [s, e] of used) { if (a + footprint - 1 < s) break; a = Math.max(a, e + 1); }
  return a + footprint - 1 <= 512 ? a : 1;
}

function newFixture(type, matrix, name, universe = 1, address = null, mode = 0) {
  const t = lib.get(type);
  const per = t.profile.personalities[mode] || t.profile.personalities[0];
  const f = { id: crypto.randomUUID(), name: name || t.profile.name, type, mode, universe, address: address ?? nextAddress(universe, per.footprint), matrix };
  S.fixtures.push(f);
  const rec = recordFor(f, records.length);
  records.push(rec);
  const fx = stage.addFixture(rec.sf);
  prepare(fx);
  save();
  return fx;
}

function placeAt() {
  placing = false; $('#placing').style.display = 'none'; $('#add').classList.remove('on');
  const targets = stage.world.children.filter((o) => o.isInstancedMesh || o === screenMesh);
  const hit = ray.intersectObjects(targets, false)[0];
  let p;
  if (hit) {
    p = stage.world.worldToLocal(hit.point.clone());
    const n = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
    if (hit.object.isInstancedMesh) { const m = new THREE.Matrix4(); hit.object.getMatrixAt(hit.instanceId, m); n.transformDirection(m); }
    p.addScaledVector(n.normalize(), 250);
  } else p = stage.world.worldToLocal(stage.controls.target.clone());
  const fx = newFixture($('#add-type').value, [1, 0, 0, 0, 1, 0, 0, 0, 1, Math.round(p.x), Math.round(p.y), Math.round(p.z)]);
  renderList(); select(fx);
}

function removeSelected() {
  if (!selected) return;
  const i = records.findIndex((r) => r.sf === selected.sf);
  stage.removeFixture(selected);
  S.fixtures.splice(i, 1);
  records.splice(i, 1);
  records.forEach((r, k) => { r.sf.fixture.index = k; });
  states = new Array(records.length);
  tc.detach(); selected = null; save(); renderList(); renderInspector();
}

function duplicateSelected() {
  if (!selected) return;
  const r = records.find((x) => x.sf === selected.sf);
  const m = r.f.matrix.slice(); m[9] += 500;
  const fx = newFixture(r.f.type, m, r.f.name, r.f.universe, null, r.f.mode);
  renderList(); select(fx);
}

addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, select, textarea')) return;
  if (ev.key === 'Escape') { if (placing) { placing = false; $('#placing').style.display = 'none'; $('#add').classList.remove('on'); } else select(null); }
  else if (ev.key === 'w' || ev.key === 'g') tc.setMode('translate');
  else if (ev.key === 'e' || ev.key === 'r') tc.setMode('rotate');
  else if (ev.key === 'a') startPlacing();
  else if ((ev.key === 'Backspace' || ev.key === 'Delete') && selected) { ev.preventDefault(); removeSelected(); }
  else if (ev.key === 'd' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); duplicateSelected(); }
});

function startPlacing() { placing = true; $('#placing').style.display = 'block'; $('#add').classList.add('on'); }
$('#add').onclick = startPlacing;

// ---------- UI: fixture list ----------
const swatch = (i) => {
  const st = states[i]; if (!st) return '#000';
  let r = 0, g = 0, b = 0, n = st.seg.length;
  for (const s of st.seg) { const k = s.shutter === 0 ? 0 : s.intensity; const rgb = s.rgb.some((v) => v) ? s.rgb : [1, 0.85, 0.6]; r += (rgb[0] + s.white) * k; g += (rgb[1] + s.white) * k; b += (rgb[2] + s.white) * k; }
  const c = (v) => Math.round(Math.min(1, v / n) * 255);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
};

function renderList() {
  $('#count').textContent = `(${S.fixtures.length})`;
  const byType = new Map();
  records.forEach((r, i) => { const k = lib.get(r.f.type)?.label || r.f.type; (byType.get(k) || byType.set(k, []).get(k)).push([r, i]); });
  let html = '';
  for (const [k, rows] of [...byType].sort()) {
    html += `<div class="grp">${esc(k)} · ${rows.length}</div>`;
    rows.sort((a, b) => a[0].f.universe - b[0].f.universe || a[0].f.address - b[0].f.address);
    for (const [r, i] of rows) {
      html += `<div class="row${selected?.sf === r.sf ? ' sel' : ''}" data-i="${i}"><span class="sw" data-sw="${i}"></span><span class="nm">${esc(r.f.lkName || r.f.name)}</span><span class="ad">${r.f.universe}.${r.f.address}</span></div>`;
    }
  }
  $('#list').innerHTML = html || '<div class="note" style="padding:10px">No fixtures. Open an MVR, or pick a type and Place light.</div>';
}
$('#list').onclick = (ev) => {
  const row = ev.target.closest('.row'); if (!row) return;
  const fx = stage.fixtures.find((f) => f.sf === records[Number(row.dataset.i)].sf);
  select(fx);
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- UI: inspector ----------
function typeOptions(sel) {
  const groups = new Map();
  for (const t of lib.values()) (groups.get(t.source) || groups.set(t.source, []).get(t.source)).push(t);
  return [...groups].map(([g, ts]) => `<optgroup label="${esc(g)}">${ts.sort((a, b) => a.label.localeCompare(b.label)).map((t) => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</optgroup>`).join('');
}

function renderInspector(positionOnly = false) {
  const el = $('#tab-fixture');
  if (!selected) { el.innerHTML = '<div class="note">Click a light in the 3D view or the list to edit it. <b>Place light</b> adds a new one where you click.</div>'; return; }
  const r = records.find((x) => x.sf === selected.sf);
  const f = r.f, root = selected.root;
  const pos = [root.position.x, root.position.y, root.position.z].map((v) => (v / FT).toFixed(2));
  const eul = new THREE.Euler().setFromQuaternion(root.quaternion, 'ZYX');
  const rot = [eul.x, eul.y, eul.z].map((v) => Math.round((v * 180) / Math.PI));
  if (positionOnly && el.querySelector('[data-k=px]')) {
    ['px', 'py', 'pz'].forEach((k, i) => { const inp = el.querySelector(`[data-k=${k}]`); if (document.activeElement !== inp) inp.value = pos[i]; });
    ['rx', 'ry', 'rz'].forEach((k, i) => { const inp = el.querySelector(`[data-k=${k}]`); if (document.activeElement !== inp) inp.value = rot[i]; });
    return;
  }
  const t = lib.get(f.type);
  const modes = t?.profile.personalities || [];
  const fp = r.per.footprint;
  const overlap = S.fixtures.filter((o) => o !== f && o.universe === f.universe).filter((o) => {
    const op = lib.get(o.type)?.profile.personalities[o.mode || 0]?.footprint || 1;
    return o.address <= f.address + fp - 1 && f.address <= o.address + op - 1;
  });
  el.innerHTML = `
    <div class="f"><span>Name</span><input type="text" data-k="name" value="${esc(f.name)}"></div>
    ${f.lkName ? `<div class="note">Lightkey: <b>${esc(f.lkName)}</b></div>` : ''}
    <div class="f"><span>Type</span><select data-k="type">${typeOptions(f.type)}</select></div>
    <div class="f"><span>Mode</span><select data-k="mode">${modes.map((m, i) => `<option value="${i}"${i === (f.mode || 0) ? ' selected' : ''}>${esc(m.name)} (${m.footprint}ch)</option>`).join('')}</select></div>
    <div class="f"><span>Universe</span><input type="number" data-k="universe" min="1" max="32768" value="${f.universe}"></div>
    <div class="f"><span>Address</span><input type="number" data-k="address" min="1" max="512" value="${f.address}"></div>
    <div class="note">Universe ${f.universe} = Art-Net ${f.universe - 1} / sACN ${f.universe} · channels ${f.address}–${f.address + fp - 1}</div>
    ${overlap.length ? `<div class="note warn">Overlaps ${overlap.map((o) => esc(o.name) + ' @' + o.address).join(', ')}</div>` : ''}
    <div class="f"><span>Position ft</span><div class="f3"><input type="number" step="0.25" data-k="px" value="${pos[0]}" title="Left/right"><input type="number" step="0.25" data-k="py" value="${pos[1]}" title="Downstage (−) / upstage (+)"><input type="number" step="0.25" data-k="pz" value="${pos[2]}" title="Height"></div></div>
    <div class="f"><span>Rotation °</span><div class="f3"><input type="number" step="5" data-k="rx" value="${rot[0]}" title="Tilt the hang (X)"><input type="number" step="5" data-k="ry" value="${rot[1]}" title="Y"><input type="number" step="5" data-k="rz" value="${rot[2]}" title="Turn (Z)"></div></div>
    <div class="btns">
      <button class="btn" data-act="move">Move (W)</button><button class="btn" data-act="rotate">Rotate (E)</button>
      <button class="btn" data-act="down">Point down</button><button class="btn" data-act="front">Face audience</button>
      <button class="btn" data-act="dup">Duplicate</button><button class="btn" data-act="del">Delete</button>
    </div>
    <h3 style="padding-left:0">Live channels</h3><table class="ch" id="chs"></table>`;
}

$('#tab-fixture').addEventListener('change', (ev) => {
  const k = ev.target.dataset.k; if (!k || !selected) return;
  const r = records.find((x) => x.sf === selected.sf), f = r.f, v = ev.target.value;
  if (k === 'name') { f.name = v; f.lkName = undefined; renderList(); }
  else if (k === 'type' || k === 'mode') {
    if (k === 'type') { f.type = v; f.mode = 0; } else f.mode = Number(v);
    const fresh = recordFor(f, records.indexOf(r));
    Object.assign(r, { profile: fresh.profile, per: fresh.per });
    r.sf.fixture.profile = fresh.profile; r.sf.fixture.per = fresh.per; r.sf.beamAngle = fresh.sf.beamAngle;
    renderList(); renderInspector();
  } else if (k === 'universe' || k === 'address') { f[k] = Math.max(1, Math.round(Number(v)) || 1); renderList(); renderInspector(); }
  else if (/^p[xyz]$/.test(k)) { selected.root.position[k[1]] = Number(v) * FT; syncMatrix(selected); }
  else if (/^r[xyz]$/.test(k)) {
    const vals = ['rx', 'ry', 'rz'].map((kk) => (Number($(`#tab-fixture [data-k=${kk}]`).value) * Math.PI) / 180);
    selected.root.quaternion.setFromEuler(new THREE.Euler(vals[0], vals[1], vals[2], 'ZYX')); syncMatrix(selected);
  }
  save();
});
$('#tab-fixture').addEventListener('click', (ev) => {
  const a = ev.target.dataset.act; if (!a || !selected) return;
  if (a === 'move') tc.setMode('translate');
  if (a === 'rotate') tc.setMode('rotate');
  if (a === 'down') { selected.root.quaternion.identity(); syncMatrix(selected); save(); renderInspector(); }
  if (a === 'front') { selected.root.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)); syncMatrix(selected); save(); renderInspector(); }
  if (a === 'dup') duplicateSelected();
  if (a === 'del') removeSelected();
});

function renderChannels() {
  const tbl = $('#chs'); if (!tbl || !selected) return;
  const r = records.find((x) => x.sf === selected.sf); if (!r) return;
  const rows = r.per.channels.map((c) => {
    const v = bridge.get(r.f.universe, r.f.address - 1 + c.index);
    return `<tr><td>${r.f.address + c.index}</td><td>${esc(c.name && c.name !== c.attr ? c.name : c.attr)}${c.segment != null ? ` <span class="note">cell ${c.segment + 1}</span>` : ''}</td><td><span class="bar" style="width:${Math.round(v / 255 * 50)}px"></span>${v}</td></tr>`;
  });
  tbl.innerHTML = rows.join('');
}

// ---------- UI: inputs ----------
function renderInputs() {
  const sc = S.screen;
  const ndiOpts = ['<option value="">None</option>', ...(bridge.ndi.sources || []).map((n) => `<option${n === sc.ndi ? ' selected' : ''}>${esc(n)}</option>`)];
  if (sc.ndi && !(bridge.ndi.sources || []).includes(sc.ndi)) ndiOpts.push(`<option selected>${esc(sc.ndi)}</option>`);
  const ft = (v) => (v / FT).toFixed(2);
  $('#tab-inputs').innerHTML = `
    <h3 style="padding-left:0">Screen (NDI)</h3>
    <div class="f"><span>Source</span><select data-k="ndi">${ndiOpts.join('')}</select></div>
    <div class="f"><span>Quality</span><select data-k="hq"><option value="0"${sc.hq ? '' : ' selected'}>Preview (light)</option><option value="1"${sc.hq ? ' selected' : ''}>Full</option></select></div>
    <div class="f"><span>Left/Right ft</span><div class="f3"><input type="number" step="0.1" data-k="left" value="${ft(sc.left)}"><input type="number" step="0.1" data-k="right" value="${ft(sc.right)}"><span></span></div></div>
    <div class="f"><span>Bottom/Top ft</span><div class="f3"><input type="number" step="0.1" data-k="bottom" value="${ft(sc.bottom)}"><input type="number" step="0.1" data-k="top" value="${ft(sc.top)}"><span></span></div></div>
    <div class="f"><span>Face ft</span><input type="number" step="0.1" data-k="face" value="${ft(sc.face)}"></div>
    <div class="note">In Arena, set the projector screen's output to <b>NDI</b>; it then appears here. ProPresenter's own NDI output works too.</div>
    <h3 style="padding-left:0">PixelStix</h3>
    <div class="f"><span>Show</span><select data-k="stixOn"><option value="1"${S.stix.on ? ' selected' : ''}>Yes (${stixLayout?.sticks?.length || 0} sticks)</option><option value="0"${S.stix.on ? '' : ' selected'}>No</option></select></div>
    <div class="f"><span>First universe</span><input type="number" data-k="stixUni" min="1" value="${S.stix.universe}"></div>
    <div class="note">Sticks 1–4 on Universe ${S.stix.universe} (Art-Net ${S.stix.universe - 1}), 5–8 on ${S.stix.universe + 1}… through ${S.stix.universe + Math.ceil((stixLayout?.sticks?.length || 24) / 4) - 1}; 4 per universe at 1, 121, 241, 361, numbered like the Arranger.</div>
    <div class="f"><span>In front ft</span><input type="number" step="0.1" data-k="stixDepth" value="${ft(S.stix.depth)}" title="Distance in front of the screen face"></div>
    <div class="f"><span>Glow</span><input type="range" min="0" max="2" step="0.05" data-k="stixGlow" value="${S.stix.glow}"></div>
    <div class="btns"><label class="btn">Open Arranger layout…<input type="file" data-k="stixFile" accept=".json" hidden></label></div>
    <h3 style="padding-left:0">Universes</h3>
    <div id="unis"></div>
    <div class="note">Live DMX comes from the bridge on this computer (<b>Start Bridge.command</b> in Arena Practice, or <b>Start Stage Vis.command</b> in Lightkey Web). It shows up as Art-Net node <b>Rig Sim</b>; Art-Net (any universe) and sACN (1–64) are received. Point Lightkey's and Arena's Art-Net output at this Mac or broadcast. Two apps on the same universe will fight, so give them different universes.</div>`;
}

$('#tab-inputs').addEventListener('change', async (ev) => {
  const k = ev.target.dataset.k; if (!k) return;
  const v = ev.target.value, sc = S.screen;
  if (k === 'ndi' || k === 'hq') { if (k === 'ndi') sc.ndi = v; else sc.hq = v === '1'; bridge.selectNdi(sc.ndi, sc.hq); if (!sc.ndi) buildScreen(); }
  else if (['left', 'right', 'bottom', 'top', 'face'].includes(k)) { sc[k] = Number(v) * FT; buildScreen(); buildStix(); }
  else if (k === 'stixOn') { S.stix.on = v === '1'; buildStix(); }
  else if (k === 'stixUni') S.stix.universe = Math.max(1, Math.round(Number(v)) || 1);
  else if (k === 'stixDepth') { S.stix.depth = Number(v) * FT; buildStix(); }
  else if (k === 'stixGlow') S.stix.glow = Number(v);
  else if (k === 'stixFile' && ev.target.files[0]) { stixLayout = JSON.parse(await ev.target.files[0].text()); S.stixLayout = stixLayout; buildStix(); }
  save(); if (k !== 'stixGlow') renderInputs();
});

function renderUnis() {
  const el = $('#unis'); if (!el) return;
  const need = new Map();
  for (const f of S.fixtures) need.set(f.universe, (need.get(f.universe) || 0) + 1);
  if (stixLayout && S.stix.on) for (let i = 0; i < stixLayout.sticks.length; i += 4) { const u = S.stix.universe + i / 4; need.set(u, (need.get(u) || 0)); }
  const all = [...new Set([...need.keys(), ...Object.keys(bridge.stats).map(Number)])].sort((a, b) => a - b);
  el.innerHTML = all.map((u) => {
    const st = bridge.stats[u];
    const live = st && st.age < 2;
    const stixHere = stixLayout && S.stix.on && u >= S.stix.universe && u < S.stix.universe + Math.ceil(stixLayout.sticks.length / 4);
    const what = [need.get(u) ? `${need.get(u)} fixtures` : '', stixHere ? 'PixelStix' : ''].filter(Boolean).join(' + ') || 'nothing patched';
    const two = st?.srcs?.length > 1;
    return `<div class="uni"><div class="t"><b>Universe ${u}</b><span class="${live ? (two ? 'warn' : '') : 'note'}">${live ? (two ? '2 senders!' : 'live') : st ? 'stopped' : 'no data'}</span></div>
      <div class="s">Art-Net ${u - 1} · ${what}${st ? ` · from ${esc((st.srcs?.length ? st.srcs : [`${st.proto} ${st.src}`]).join(', '))}` : ''}</div></div>`;
  }).join('') || '<div class="note">Nothing yet.</div>';
}

// ---------- UI: library ----------
function renderLibrary() {
  const groups = new Map();
  for (const t of lib.values()) (groups.get(t.source) || groups.set(t.source, []).get(t.source)).push(t);
  $('#tab-library').innerHTML = `<div class="note">Fixture types come from <b>.gdtf</b> files (download them from GDTF Share; Capture's MVR export only has placeholders), your <b>Lightkey project</b>'s profiles, and a few generic types. Drop files on the window or use <b>Fixture files</b>.</div>` +
    [...groups].map(([g, ts]) => `<h3 style="padding-left:0">${esc(g)}</h3>` + ts.map((t) => `<div class="note">${esc(t.label)} · ${t.profile.personalities.map((p) => `${esc(p.name)} ${p.footprint}ch`).join(', ')}${t.profile.placeholder ? ' <span class="warn">(placeholder: no channel data)</span>' : ''}</div>`).join('')).join('');
  $('#add-type').innerHTML = typeOptions($('#add-type').value || 'gen:drgb');
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'inputs') renderInputs();
  if (name === 'library') renderLibrary();
}
document.querySelector('.tabs').onclick = (ev) => { if (ev.target.dataset.tab) showTab(ev.target.dataset.tab); };

// ---------- status ----------
function status() {
  const pill = (id, cls, text) => { const p = $(id); p.className = `pill ${cls}`; p.textContent = text; };
  pill('#p-bridge', bridge.ok ? 'good' : 'bad', bridge.ok ? 'Bridge on' : 'Bridge off');
  const off = $('#offline');
  off.style.display = bridge.ok ? 'none' : 'block';
  if (!bridge.ok) off.innerHTML = `<b>No live input.</b> The 3D view and layout work, but DMX and NDI need the bridge running on this computer: double-click <b>Start Bridge.command</b> in Documents/Claude/Arena Practice.${HOSTED ? ' In Chrome, allow this site to reach devices on your local network when it asks.' : ''}`;
  const live = Object.entries(bridge.stats).filter(([, s]) => s.age < 2);
  const clash = live.some(([, s]) => s.srcs?.length > 1);
  pill('#p-dmx', live.length ? (clash ? 'warn' : 'good') : '', live.length ? `DMX ${live.length} universe${live.length > 1 ? 's' : ''}${clash ? ' · clash' : ''}` : 'No DMX');
  const n = bridge.ndi;
  pill('#p-ndi', S.screen.ndi ? (n.connected ? 'good' : 'warn') : '', S.screen.ndi ? (n.connected ? `NDI ${n.fps || ''} fps` : 'NDI waiting') : 'No screen feed');
  document.querySelectorAll('[data-sw]').forEach((s) => { s.style.background = swatch(Number(s.dataset.sw)); });
  renderChannels();
  if (!$('#tab-inputs').classList.contains('hidden')) {
    renderUnis();
    const sel = $('#tab-inputs [data-k=ndi]');
    if (sel && document.activeElement !== sel && sel.options.length - 1 < (bridge.ndi.sources || []).length) renderInputs();
  }
}
setInterval(status, 250);

// ---------- files ----------
async function openFile(file, bytes = null, remember = true) {
  const name = file.name;
  bytes ||= new Uint8Array(await file.arrayBuffer());
  if (/\.mvr$/i.test(name)) {
    scene = readMvr(bytes, name);
    for (const [n, data] of Object.entries(unzipSync(bytes)).filter(([n]) => /\.gdtf$/i.test(n))) {
      try { useGdtf(data, n); } catch { /* empty placeholder */ }
    }
    if (S.mvr !== name || !S.fixtures.length) {
      // New MVR: take its fixtures as the starting layout.
      S.mvr = name;
      S.fixtures = scene.fixtures.filter((f) => f.address > 0).map((sf) => {
        const prof = [...lib.values()].find((t) => t.profile.fileName?.replace(/\.gdtf$/i, '') === sf.gdtf.replace(/\.gdtf$/i, ''));
        const mode = prof ? Math.max(0, prof.profile.personalities.findIndex((p) => p.name === sf.mode)) : 0;
        return { id: crypto.randomUUID(), name: sf.name, type: prof?.id || 'gen:dimmer', mode, universe: sf.universe + 1, address: sf.address, matrix: sf.matrix };
      });
      if (project) useProject(project, '');
    }
    if (remember) saveFile('vis-mvr', name, bytes);
    rebuildAll();
    toast(`${name}: ${scene.stats.fixtures} fixtures, ${scene.stats.triangles.toLocaleString()} triangles`);
  } else if (/\.lightkeyproj$/i.test(name)) {
    const p = readLightkey(bytes, name);
    const n = useProject(p, name.replace(/\.lightkeyproj$/i, ''));
    if (remember) saveFile('vis-lk', name, bytes);
    rebuildAll(); save();
    toast(`${name}: ${p.fixtures.length} fixture profiles${n ? `, ${n} lights matched by address` : ''}`);
  } else if (/\.gdtf$/i.test(name)) {
    const prof = useGdtf(bytes, name);
    if (remember) saveFile('vis-gdtf', name, bytes);
    // Lights in the layout that use a placeholder with this name now get the real file.
    let n = 0;
    for (const f of S.fixtures) {
      const cur = lib.get(f.type);
      if (cur?.profile.placeholder && cur.profile.name === prof.name) { f.type = `gdtf:${prof.uuid}`; n++; }
    }
    rebuildAll(); save();
    toast(`${prof.manufacturer} ${prof.name}: ${prof.personalities.length} modes${prof.placeholder ? ' (placeholder, no channel data)' : ''}${n ? `, used by ${n} lights` : ''}`);
  } else if (/\.json$/i.test(name)) {
    const j = JSON.parse(new TextDecoder().decode(bytes));
    if (j.app === 'stix-arranger') { stixLayout = j; S.stixLayout = j; buildStix(); save(); toast(`Stick layout: ${j.sticks.length} sticks`); return; }
    if (!Array.isArray(j.fixtures)) throw new Error('Not a Stage Vis layout');
    Object.assign(S, j); save(); rebuildAll(); toast(`Layout: ${S.fixtures.length} fixtures`);
  } else toast(`Can't open ${name}`);
  renderLibrary();
}

const pick = (sel) => $(sel).addEventListener('change', async (ev) => { for (const f of ev.target.files) await openFile(f).catch((e) => toast(e.message, 5000)); ev.target.value = ''; });
pick('#open-mvr'); pick('#open-lib'); pick('#open-layout');
addEventListener('dragover', (ev) => { ev.preventDefault(); $('#drop').classList.add('on'); });
addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) $('#drop').classList.remove('on'); });
addEventListener('drop', async (ev) => {
  ev.preventDefault(); $('#drop').classList.remove('on');
  for (const f of ev.dataTransfer.files) await openFile(f).catch((e) => toast(e.message, 5000));
});

$('#save').onclick = () => {
  const blob = new Blob([JSON.stringify({ app: 'stage-vis', version: 1, ...S }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${(S.mvr || 'Stage').replace(/\.mvr$/i, '')} layout.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

$('#add-missing').onclick = () => {
  if (!project) return toast('Open a Lightkey project first (Fixture files)');
  const have = new Set(S.fixtures.map((f) => `${f.universe}:${f.address}`));
  const missing = project.fixtures.filter((f) => !have.has(`${f.universe}:${f.address}`));
  if (!missing.length) return toast('Every Lightkey fixture is already placed');
  // A row along the front of the stage at 20 ft, so they're easy to find and drag into place.
  missing.forEach((m, i) => {
    const x = (i - (missing.length - 1) / 2) * 700;
    const f = { id: crypto.randomUUID(), name: m.name, lkName: m.name, type: `lk:${m.profile.uuid}`, mode: m.per.index, universe: m.universe, address: m.address, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1, Math.round(x), -4500, 6100] };
    S.fixtures.push(f);
  });
  save(); rebuildAll();
  toast(`Placed ${missing.length} fixtures in a row above the stage. Drag them where they hang.`, 5000);
};

document.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => stage.frame(b.dataset.view); });
$('#haze').value = S.haze; $('#house').value = S.house;
$('#haze').oninput = (ev) => { S.haze = stage.haze = Number(ev.target.value); save(); };
$('#house').oninput = (ev) => { S.house = Number(ev.target.value); stage.setHouse(S.house); save(); };

// ---------- start ----------
async function restore(kind, fallback) {
  const files = await listFiles(kind);
  if (files.length) {
    for (const f of kind === 'vis-mvr' ? files.slice(0, 1) : files) {
      const rec = await getFile(kind, f.name);
      if (rec?.bytes) await openFile({ name: f.name }, rec.bytes, false).catch(() => {});
    }
    return true;
  }
  if (!fallback || HOSTED) return false;
  try {
    const r = await fetch(fallback);
    if (!r.ok) return false;
    const name = decodeURIComponent(fallback.split('/').pop());
    await openFile({ name }, new Uint8Array(await r.arrayBuffer()));
    return true;
  } catch { return false; }
}

(async () => {
  stixLayout = S.stixLayout || await fetch('stage-vis/stix-layout.json').then((r) => r.json()).catch(() => null);
  renderLibrary();
  await restore('vis-gdtf');
  await restore('vis-lk', 'samples/ABIDE%2026.lightkeyproj');
  const hadMvr = await restore('vis-mvr', 'samples/River%20Church%20MVR.mvr');
  if (!hadMvr) rebuildAll();
  if (S.screen.ndi) bridge.selectNdi(S.screen.ndi, S.screen.hq);
  showTab(selected ? 'fixture' : 'inputs');
  window.vis = { S, lib, bridge, stage, stix, openFile, get records() { return records; }, get states() { return states; } };
})();
