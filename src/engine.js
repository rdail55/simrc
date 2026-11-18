// Playback engine: active cues and palette presets → per-fixture state (for the visualisers) and DMX universes.
//
// Merge model (after Lightkey's): palette presets beat cues; cues are ordered by page priority, frame priority,
// cue priority, then most recently activated. Each layer has a fade level 0–1, and layers are applied lowest
// first, each one blending the properties it defines toward its own values by its level. A fully faded-in
// top layer therefore wins, and fading a layer out reveals what is underneath.
import { unpackColor } from './lightkey.js';
import { writeDMX } from './profiles.js';

const frac = (x) => x - Math.floor(x);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- curves and paths --------------------------------------------------------------------------------------

/** Lightkey effect curve: control points (x, y in 0–1), each segment straight or curved (smooth through points). */
export function evalCurve(curve, x) {
  const p = curve?.points;
  if (!p || !p.length) return x;
  if (x <= p[0][0]) return p[0][1];
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    if (x > x1 && i < p.length - 2) continue;
    const t = x1 > x0 ? clamp01((x - x0) / (x1 - x0)) : 0;
    if (!curve.curved?.[i]) return lerp(y0, y1, t);
    // Cubic Hermite with Catmull-Rom tangents (scaled to this segment's width).
    const pm = p[i - 1] || p[i], pp = p[i + 2] || p[i + 1];
    const w = x1 - x0 || 1;
    const m0 = ((y1 - pm[1]) / ((x1 - pm[0]) || 1)) * w;
    const m1 = ((pp[1] - y0) / ((pp[0] - x0) || 1)) * w;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * m1;
  }
  return p[p.length - 1][1];
}

/** Closed loop through key positions; Catmull-Rom when smooth. Returns [pan, tilt] radians.
 *  As in Lightkey, the time between two points depends on their distance (constant speed). */
function evalPath(points, u, smooth) {
  const n = points.length;
  if (!n) return [0, 0];
  if (n === 1) return points[0];
  const lens = points.map((p, k) => Math.hypot(points[(k + 1) % n][0] - p[0], points[(k + 1) % n][1] - p[1]) || 1e-6);
  const total = lens.reduce((a, b) => a + b, 0);
  let dist = frac(u) * total, i = 0;
  while (i < n - 1 && dist > lens[i]) { dist -= lens[i]; i++; }
  const t = Math.min(1, dist / lens[i]);
  const P = (k) => points[((k % n) + n) % n];
  const a = P(i - 1), b = P(i), c = P(i + 1), d = P(i + 2);
  if (!smooth) return [lerp(b[0], c[0], t), lerp(b[1], c[1], t)];
  const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  return [cr(a[0], b[0], c[0], d[0]), cr(a[1], b[1], c[1], d[1])];
}

const DEG = Math.PI / 180;
// Lightkey's built-in movement paths aren't stored in the project; approximate them around the current position.
function builtinPath(id, u) {
  const a = 2 * Math.PI * u;
  const s = String(id).toLowerCase();
  if (/eight|8/.test(s)) return [Math.sin(a) * 30 * DEG, Math.sin(2 * a) * 15 * DEG];
  if (/tilt|vertical|nod/.test(s)) return [0, Math.sin(a) * 25 * DEG];
  if (/pan|line|horizontal|sweep/.test(s)) return [Math.sin(a) * 40 * DEG, 0];
  return [Math.cos(a) * 25 * DEG, Math.sin(a) * 15 * DEG];
}

// ---- fixture state ------------------------------------------------------------------------------------------

function freshState(fx) {
  const n = Math.max(1, fx.per?.segments || 1);
  return {
    seg: Array.from({ length: n }, () => ({ intensity: 0, rgb: [1, 1, 1], white: 0, amber: 0, uv: 0, warmWhite: 0, shutter: 1, strobeSpeed: 0 })),
    pan: 0, tilt: 0, zoomAngle: null, focus: 0.5, gobo: [null, null], wheel: null, fog: 0, custom: {},
  };
}

const SNAP = 0.5; // discrete properties (gobo, shutter mode, wheel slot) switch half-way through a fade

function applyContainer(st, fx, uc, level, scale) {
  const feats = uc.definedFeatures || [];
  const fc = uc.fixtureContainer || {};
  const segs = uc.segmentContainers || [];
  const has = (f) => feats.includes(f);
  st.seg.forEach((s, i) => {
    const v = segs[i] || segs[0];
    if (!v) return;
    if (has('Intensity') && v.intensity != null) s.intensity = lerp(s.intensity, v.intensity * scale, level);
    if (has('Shutter') && v.shutterState != null && level >= SNAP) { s.shutter = v.shutterState; s.strobeSpeed = v.strobeSpeed ?? v.shutterPulseSpeed ?? s.strobeSpeed; }
    if (has('Color') && v.color?.length) {
      const c = unpackColor(v.color[0]);
      s.rgb = [lerp(s.rgb[0], c[0], level), lerp(s.rgb[1], c[1], level), lerp(s.rgb[2], c[2], level)];
      s.white = lerp(s.white, v.coolWhite || 0, level);
      s.amber = lerp(s.amber, v.amber || 0, level);
      s.uv = lerp(s.uv, v.ultraviolet || 0, level);
      s.warmWhite = lerp(s.warmWhite, v.warmWhite || 0, level);
    }
  });
  const v0 = segs[0] || {};
  if (has('PanTilt') && v0.panAngle != null) {
    st.pan = lerp(st.pan, v0.panAngle, level);
    st.tilt = lerp(st.tilt, v0.tiltAngle ?? st.tilt, level);
  }
  if (has('Zoom') && fc.zoomAngle != null) st.zoomAngle = st.zoomAngle == null ? fc.zoomAngle : lerp(st.zoomAngle, fc.zoomAngle, level);
  if (has('Focus') && fc.focus != null) st.focus = lerp(st.focus, fc.focus, level);
  if (has('Fog') && fc.fogAmount != null) st.fog = lerp(st.fog, fc.fogAmount * scale, level);
  if (level >= SNAP) {
    if (has('GoboWheel0') && fc.gobo0) st.gobo[0] = fc.gobo0.identifier;
    if (has('GoboWheel1') && fc.gobo1) st.gobo[1] = fc.gobo1.identifier;
    if (has('ColorWheel0') && fc.color0) {
      const comp = fc.color0.split?._0?.[0]?.component?._0?.[0] ?? fc.color0.component?._0?.[0];
      if (comp != null) st.wheel = unpackColor(comp);
    }
    for (const k of feats) {
      if (!k.startsWith('custom--') || !fc[k]) continue;
      st.custom[Number(k.slice(k.lastIndexOf('--') + 2))] = fc[k];
    }
  }
}

function applyEffect(states, project, e, t, level, scale) {
  const p = e.params || {};
  const ids = e.extent;
  const n = e.pixels || ids.length || 1;
  const dur = Math.max(0.05, p.duration || 1);
  ids.forEach((id, idx) => {
    const fx = project.fixtureById.get(id);
    if (!fx) return;
    const st = states[fx.index];
    const k = e.pos?.[id] ?? idx; // pixel number (fixture order)
    switch (e.cls) {
      case 3000: { // curve
        // Time offset: each pixel runs shift × duration behind the previous one.
        const pos = (c) => frac(t / dur - k * (p[`shift${c}`] ?? 0));
        if (e.feature === 'Intensity') {
          const y = evalCurve(p.curves?.[0], pos(0));
          for (const s of st.seg) s.intensity = lerp(s.intensity, clamp01(y) * scale, level);
        } else if (e.feature === 'PanTilt') {
          const sign = p.mirrorPan && k % 2 ? -1 : 1;
          if (p.curves?.[0]) st.pan += sign * (evalCurve(p.curves[0], pos(0)) - 0.5) * Math.PI * level;
          if (p.curves?.[1]) st.tilt += (evalCurve(p.curves[1], pos(1)) - 0.5) * (Math.PI / 2) * level * (p.mirrorTilt && k % 2 ? -1 : 1);
        } else if (e.feature === 'Zoom') {
          const z = fx.per?.zoom;
          if (z) {
            const a = lerp(z.minAngle, z.maxAngle, clamp01(evalCurve(p.curves?.[0], pos(0))));
            st.zoomAngle = st.zoomAngle == null ? a : lerp(st.zoomAngle, a, level);
          }
        }
        break;
      }
      case 1000: { // pattern: chase / rain through a list of values
        const vals = p.values || [];
        if (!vals.length) break;
        const len = vals.length;
        if (p.pattern === 3000) { // rain: a lit head moving across the fixtures with a tail
          const span = n + (p.rainDistance || 0);
          const head = frac(t / dur) * span;
          const tail = Math.max(1, p.rainLength || 1);
          const d = ((head - k) % span + span) % span;
          const on = d < tail ? 1 - d / tail : 0;
          const lo = typeof vals[0] === 'number' ? vals[0] : 0, hi = typeof vals[len - 1] === 'number' ? vals[len - 1] : 1;
          const y = lerp(lo, hi, on);
          if (e.feature === 'Intensity') for (const s of st.seg) s.intensity = lerp(s.intensity, y * scale, level);
          break;
        }
        // Chase: the duration is one full cycle through the samples; each pixel runs chaseShift samples behind.
        const pos = (t / dur) * len - k * (p.chaseShift ?? 0);
        const i0 = ((Math.floor(pos) % len) + len) % len, i1 = (i0 + 1) % len;
        const smooth = p.chaseSmoothness ?? p.scannerSmoothness ?? 0;
        const x = frac(pos);
        const mix = smooth > 0 ? clamp01((x - (1 - smooth)) / smooth) : 0;
        const a = vals[i0], b = vals[i1];
        if (e.feature === 'Intensity' && typeof a === 'number') {
          const y = lerp(a, b, mix);
          for (const s of st.seg) s.intensity = lerp(s.intensity, y * scale, level);
        } else if (e.feature === 'Color' && a?.rgb) {
          const rgb = [0, 1, 2].map((c) => lerp(a.rgb[c], b.rgb[c], mix));
          for (const s of st.seg) {
            s.rgb = s.rgb.map((v, c) => lerp(v, rgb[c], level));
            s.white = lerp(s.white, lerp(a.white, b.white, mix), level);
            s.amber = lerp(s.amber, lerp(a.amber, b.amber, mix), level);
          }
        }
        break;
      }
      case 2000: { // movement path
        const u = t / dur - k * (p.phasing ?? 0);
        const path = project.movementPaths.get(p.movementPathIdentifier);
        let pan, tilt;
        if (path?.points.length) [pan, tilt] = evalPath(path.points, u, path.smooth);
        else { const [dp, dt] = builtinPath(p.movementPathIdentifier, frac(u)); pan = st.pan + dp; tilt = st.tilt + dt; }
        if (p.mirrorPan && k % 2) pan = -pan;
        if (p.mirrorTilt && k % 2) tilt = -tilt;
        pan += k * (p.panOffset || 0);
        st.pan = lerp(st.pan, pan, level);
        st.tilt = lerp(st.tilt, tilt, level);
        break;
      }
      case 6000: { // spread: positions fanned across the fixtures
        const stops = p.stops || [];
        if (!stops.length || e.feature !== 'PanTilt') break;
        const [pan, tilt] = stops.length === 1 ? stops[0] : (() => {
          const f = (n > 1 ? k / (n - 1) : 0) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f));
          return [lerp(stops[i][0], stops[i + 1][0], f - i), lerp(stops[i][1], stops[i + 1][1], f - i)];
        })();
        st.pan = lerp(st.pan, pan, level);
        st.tilt = lerp(st.tilt, tilt, level);
        break;
      }
      default: break;
    }
  });
}

// ---- engine -------------------------------------------------------------------------------------------------

export class Engine {
  constructor(project) {
    this.project = project;
    this.layers = new Map(); // key → layer
    this.seq = 0;
    this.master = 1;
    this.blackout = false;
    this.bpmSpeed = 1;
    this.states = project.fixtures.map(freshState);
    this.dmx = new Map(project.universes.map((u) => [u.index, new Uint8Array(512)]));
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) fn(); }

  /** ctx: { pagePriority, framePriority, frameSpeed, fade (page default), level (fader 0–1) } */
  activateCue(cue, ctx = {}) {
    const key = `cue:${cue.uuid}`;
    const now = performance.now();
    const existing = this.layers.get(key);
    const layer = existing || { key, kind: 'cue', cue, presets: cue.presets, level: 0, start: now };
    layer.target = 1;
    layer.releasing = false;
    layer.fadeIn = ctx.fadeIn ?? cue.fadeIn;
    layer.fadeOut = cue.fadeOut;
    layer.prio = [1, ctx.pagePriority ?? 5, ctx.framePriority ?? 5, cue.priority ?? 5];
    layer.speed = (cue.speed || 1) * (ctx.frameSpeed || 1);
    layer.scale = (cue.intensity ?? 1) * (ctx.level ?? 1);
    layer.seq = ++this.seq;
    if (!existing) { layer.start = now; this.layers.set(key, layer); }
    this.changed();
  }

  releaseCue(cue, fadeOut) {
    const layer = this.layers.get(`cue:${cue.uuid}`);
    if (!layer) return;
    layer.target = 0;
    layer.releasing = true;
    if (fadeOut != null) layer.fadeOut = fadeOut;
    this.changed();
  }

  /** Fader: the cue runs while its level is above zero; the level scales its intensity. */
  setCueLevel(cue, v, ctx = {}) {
    const key = `cue:${cue.uuid}`;
    if (v <= 0.001) { const l = this.layers.get(key); if (l) { l.target = 0; l.releasing = true; l.fadeOut = 0; } this.changed(); return; }
    if (!this.layers.has(key)) this.activateCue(cue, { ...ctx, fadeIn: 0 });
    const l = this.layers.get(key);
    l.scale = (cue.intensity ?? 1) * v;
    l.level = 1;
    l.target = 1;
    l.releasing = false;
  }

  isCueActive(cue) { const l = this.layers.get(`cue:${cue.uuid}`); return !!l && !l.releasing; }
  cueLevel(cue) { return this.layers.get(`cue:${cue.uuid}`)?.level || 0; }

  togglePreset(preset, on = !this.isPresetActive(preset)) {
    const key = `preset:${preset.uuid}`;
    if (on) {
      const now = performance.now();
      this.layers.set(key, { key, kind: 'preset', preset, presets: [preset], level: 0, target: 1, fadeIn: 0.3, fadeOut: 0.3, prio: [2, 0, 0, 0], seq: ++this.seq, speed: 1, scale: 1, start: now });
    } else {
      const l = this.layers.get(key);
      if (l) { l.target = 0; l.releasing = true; }
    }
    this.changed();
  }

  isPresetActive(preset) { const l = this.layers.get(`preset:${preset.uuid}`); return !!l && !l.releasing; }

  /** The look being built in the editor, on top of everything. store: { containers, effects } or null.
   *  start: effect clock origin (performance.now() ms), so effects can be locked to the song's beat grid. */
  setProgrammer(store, start = performance.now()) {
    const key = 'programmer';
    if (!store) { this.layers.delete(key); this.changed(); return; }
    const l = this.layers.get(key);
    const preset = { uuid: 'programmer', name: 'Programmer', ...store };
    if (l) { l.presets = [preset]; l.start = start; l.target = 1; l.releasing = false; return; }
    this.layers.set(key, { key, kind: 'programmer', presets: [preset], level: 1, target: 1, fadeIn: 0.2, fadeOut: 0.2, prio: [3, 0, 0, 0], seq: ++this.seq, speed: 1, scale: 1, start });
    this.changed();
  }

  /** Swap in a re-read project (after an edit) and keep running cues where they still exist. */
  setProject(project) {
    this.project = project;
    for (const [key, l] of [...this.layers]) {
      if (l.kind === 'cue') {
        const cue = project.cues.get(l.cue.uuid);
        if (cue) { l.cue = cue; l.presets = cue.presets; } else this.layers.delete(key);
      } else if (l.kind === 'preset') {
        const p = project.presets.get(l.preset.uuid);
        if (p) { l.preset = p; l.presets = [p]; } else this.layers.delete(key);
      }
    }
    this.states = project.fixtures.map(freshState);
    this.dmx = new Map(project.universes.map((u) => [u.index, new Uint8Array(512)]));
    this.changed();
  }

  releaseAll(fade = 1) {
    for (const l of this.layers.values()) { l.target = 0; l.releasing = true; l.fadeOut = fade; }
    this.changed();
  }

  tick(now = performance.now()) {
    const dt = this.last ? Math.min(0.25, (now - this.last) / 1000) : 0;
    this.last = now;
    let removed = false;
    for (const [key, l] of this.layers) {
      const dur = l.target > l.level ? l.fadeIn : l.fadeOut;
      const step = dur > 0 ? dt / dur : 1;
      l.level = l.target > l.level ? Math.min(l.target, l.level + step) : Math.max(l.target, l.level - step);
      if (l.releasing && l.level <= 0) { this.layers.delete(key); removed = true; }
    }
    if (removed) this.changed();

    const { project } = this;
    const states = project.fixtures.map(freshState);
    const ordered = [...this.layers.values()].sort((a, b) => {
      for (let i = 0; i < 4; i++) if (a.prio[i] !== b.prio[i]) return a.prio[i] - b.prio[i];
      return a.seq - b.seq;
    });
    for (const l of ordered) {
      if (l.level <= 0) continue;
      const t = ((now - l.start) / 1000) * l.speed * (l.kind === 'programmer' ? 1 : this.bpmSpeed);
      for (const preset of l.presets) {
        for (const [fid, uc] of Object.entries(preset.containers)) {
          const fx = project.fixtureById.get(fid);
          if (fx) applyContainer(states[fx.index], fx, uc, l.level, l.scale);
        }
        for (const e of preset.effects) applyEffect(states, project, e, t, l.level, l.scale);
      }
    }
    const m = this.blackout ? 0 : this.master;
    for (const st of states) for (const s of st.seg) s.intensity = clamp01(s.intensity) * m;
    this.states = states;

    for (const buf of this.dmx.values()) buf.fill(0);
    project.fixtures.forEach((fx, i) => {
      const buf = this.dmx.get(fx.universe);
      if (buf && fx.per) writeDMX(buf, fx.address - 1, fx.profile, fx.per, states[i]);
    });
    return states;
  }
}

// ---- what a fixture looks like ------------------------------------------------------------------------------

const WARM = [1, 0.85, 0.65];

/** Visible colour + brightness of one segment (strobe and shutter applied). */
export function segmentLook(fx, s, st, now) {
  let rgb;
  if (fx.per?.hasColor) {
    rgb = [0, 1, 2].map((c) => s.rgb[c] + s.white + s.amber * [1, 0.6, 0][c] + (s.warmWhite || 0) * WARM[c] + s.uv * [0.35, 0, 0.8][c] * 0.6);
    const mx = Math.max(1, ...rgb);
    rgb = rgb.map((v) => v / mx);
  } else if (st.wheel) rgb = st.wheel;
  else rgb = fx.profile.kind === 'fog' ? [0.8, 0.8, 0.85] : WARM;
  let b = s.intensity;
  if (fx.profile.kind === 'fog') b = st.fog;
  if (s.shutter === 0) b = 0;
  else if (s.shutter >= 2) {
    const hz = Math.max(0.5, Math.min(25, s.strobeSpeed || 8));
    const phase = frac((now / 1000) * hz + fx.index * (s.shutter === 5 ? 0.37 : 0));
    if (phase > 0.35) b = 0;
  }
  return { rgb, b };
}
