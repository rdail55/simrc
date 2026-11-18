// The look builder: a selection of fixtures + static values (intensity, colour, position, zoom) + tempo-based
// effects from a built-in library, compiled into a Lightkey preset store (the fpStore of an LXPreset).
//
// Effects are defined in musical units (beats, bars). They are compiled to Lightkey effects with *fixed*
// durations in seconds at the current BPM, so once written to a Live page they no longer follow the tempo.
// The browser preview decodes the very same bytes that get written, so what you see is what Lightkey gets.
//
// Effect parameters follow Lightkey's User Guide (6.0.2) and the shapes in Lightkey's own Effects Showcase:
//   curve (3000): duration, shift0 = time offset per pixel (fraction of duration), wrappedCurve0
//   pattern (1000): values (samples), pattern, duration, chaseShift (offset per pixel, fraction of one sample),
//                   chaseSmoothness
//   movement (2000): movementPathIdentifier, duration, phasing (offset per pixel), panOffset, mirrorPan
// Fixture order is written as a custom order (orderedPixelRefs): pixels with the same number move together.
import { writeBplist, real, UID } from './bplist.js';
import { decodeNested } from './nska.js';

// ---- musical time -------------------------------------------------------------------------------------------

export const RATES = [
  { id: '1/2', label: '½ beat', beats: 0.5 },
  { id: '1', label: '1 beat', beats: 1 },
  { id: '2', label: '2 beats', beats: 2 },
  { id: 'bar', label: '1 bar', beats: 4 },
  { id: '2bar', label: '2 bars', beats: 8 },
  { id: '4bar', label: '4 bars', beats: 16 },
  { id: '8bar', label: '8 bars', beats: 32 },
];
export const rateBeats = (id) => RATES.find((r) => r.id === id)?.beats ?? 4;
export const secondsFor = (rateId, bpm) => (rateBeats(rateId) * 60) / bpm;

export const ORDERS = [
  { id: 'ltr', label: 'Left → right' },
  { id: 'rtl', label: 'Right → left' },
  { id: 'out', label: 'Centre out' },
  { id: 'in', label: 'Edges in' },
  { id: 'alt', label: 'Odd / even' },
  { id: 'all', label: 'All together' },
];

// ---- curves -------------------------------------------------------------------------------------------------

const C = (pts, curved = true) => ({ points: pts, curved: pts.slice(1).map(() => curved) });
const sine = (lo = 0, hi = 1) => C(Array.from({ length: 9 }, (_, i) => [i / 8, lo + (hi - lo) * (0.5 - 0.5 * Math.cos((i / 8) * 2 * Math.PI))]));
const CURVES = {
  pulse: { points: [[0, 1], [0.2, 0.5], [0.55, 0.12], [1, 0.05]], curved: [true, true, true] },
  hit: { points: [[0, 1], [0.12, 1], [0.13, 0], [1, 0]], curved: [false, false, false] },
  breathe: sine(0.15, 1),
  wave: sine(0, 1),
  runner: { points: [[0, 0], [0.03, 1], [0.2, 1], [0.3, 0], [1, 0]], curved: [false, true, true, false] },
  square: { points: [[0, 1], [0.49, 1], [0.5, 0], [0.99, 0], [1, 1]], curved: [false, false, false, false] },
  build: { points: [[0, 0.05], [1, 1]], curved: [false] },
  zoom: sine(0, 1),
};

// ---- the library --------------------------------------------------------------------------------------------
// kind: which fixture property; needs: 'color' | 'pantilt' | 'zoom' | null (fixtures without it are skipped).

export const EFFECTS = [
  { id: 'pulse', name: 'Pulse', group: 'Intensity', desc: 'A punch on every beat that decays.', rate: '1', order: 'all', make: 'curve', curve: 'pulse', feature: 'Intensity' },
  { id: 'hit', name: 'Flash hit', group: 'Intensity', desc: 'Short full flash, dark in between.', rate: '1', order: 'all', make: 'curve', curve: 'hit', feature: 'Intensity' },
  { id: 'breathe', name: 'Breathe', group: 'Intensity', desc: 'Slow swell up and down.', rate: '4bar', order: 'all', make: 'curve', curve: 'breathe', feature: 'Intensity' },
  { id: 'wave', name: 'Wave', group: 'Intensity', desc: 'A swell that travels across the fixtures.', rate: '2bar', order: 'ltr', make: 'curve', curve: 'wave', feature: 'Intensity', spread: true },
  { id: 'chase', name: 'Chase', group: 'Intensity', desc: 'One light runs across, one pass per cycle.', rate: 'bar', order: 'ltr', make: 'curve', curve: 'runner', feature: 'Intensity', spread: true },
  { id: 'alternate', name: 'Odd / even', group: 'Intensity', desc: 'Two halves swap on the rate.', rate: '1', order: 'alt', make: 'curve', curve: 'square', feature: 'Intensity', half: true },
  { id: 'build', name: 'Build', group: 'Intensity', desc: 'Ramps up, then snaps back. Use 4 or 8 bars.', rate: '4bar', order: 'all', make: 'curve', curve: 'build', feature: 'Intensity' },
  { id: 'colorRoll', name: 'Colour roll', group: 'Colour', desc: 'Blends through the chosen colours, offset across fixtures.', rate: '4bar', order: 'ltr', make: 'chase', feature: 'Color', needs: 'color', smooth: 1, spread: true },
  { id: 'colorSwap', name: 'Colour swap', group: 'Colour', desc: 'Odd / even fixtures swap between two colours.', rate: '2', order: 'alt', make: 'chase', feature: 'Color', needs: 'color', smooth: 0.15, half: true },
  { id: 'colorFade', name: 'Colour fade', group: 'Colour', desc: 'Everything fades through the colours together.', rate: '4bar', order: 'all', make: 'chase', feature: 'Color', needs: 'color', smooth: 1 },
  { id: 'circle', name: 'Circle', group: 'Movement', desc: 'Circles around the base position.', rate: '2bar', order: 'all', make: 'path', path: 'circle', feature: 'PanTilt', needs: 'pantilt' },
  { id: 'eight', name: 'Figure 8', group: 'Movement', desc: 'Figure-of-eight around the base position.', rate: '4bar', order: 'all', make: 'path', path: 'eight', feature: 'PanTilt', needs: 'pantilt' },
  { id: 'sweep', name: 'Pan sweep', group: 'Movement', desc: 'Side to side. Odd/even makes the beams cross.', rate: '2bar', order: 'all', make: 'path', path: 'pan', feature: 'PanTilt', needs: 'pantilt', half: true },
  { id: 'nod', name: 'Tilt wave', group: 'Movement', desc: 'Up and down, rippling across the movers.', rate: '2bar', order: 'ltr', make: 'path', path: 'tilt', feature: 'PanTilt', needs: 'pantilt', spread: true },
  { id: 'zoomPulse', name: 'Zoom pulse', group: 'Beam', desc: 'Beams open and close.', rate: 'bar', order: 'all', make: 'curve', curve: 'zoom', feature: 'Zoom', needs: 'zoom' },
];

export const SIZES = { s: 10, m: 22, l: 40 }; // movement size, degrees

// ---- fixture order --------------------------------------------------------------------------------------------

/** Pixel numbers for an order: fixtures with the same number act as one. Returns [{ fx, pos }]. */
export function orderPixels(fixtures, order) {
  const sorted = [...fixtures].sort((a, b) => (a.stage?.x ?? 1e9) - (b.stage?.x ?? 1e9) || (b.stage?.y ?? 0) - (a.stage?.y ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const n = sorted.length;
  return sorted.map((fx, i) => {
    const c = Math.round(Math.abs(i - (n - 1) / 2) - (n % 2 ? 0 : 0.5));
    const maxC = Math.round(Math.abs(0 - (n - 1) / 2) - (n % 2 ? 0 : 0.5));
    const pos = { ltr: i, rtl: n - 1 - i, out: c, in: maxC - c, alt: i % 2, all: 0 }[order] ?? i;
    return { fx, pos };
  });
}

const pixelCount = (pixels) => new Set(pixels.map((p) => p.pos)).size;

// ---- keyed-archive encoding for effect parameters --------------------------------------------------------------

const ARCHIVE_CLASSES = {
  NSDictionary: ['NSDictionary', 'NSObject'],
  NSArray: ['NSArray', 'NSObject'],
  LXWrappedCurve: ['LXWrappedCurve', 'NSObject'],
  LXExtendedColor: ['LXExtendedColor', 'NSObject'],
  LXRGBColor: ['LXRGBColor', 'LXComponentColor', 'LXHomogeneousColor', 'LXColor', 'NSObject'],
};

function archive(rootDict) {
  const objects = ['$null'];
  const classUIDs = {};
  const push = (o) => { objects.push(o); return new UID(objects.length - 1); };
  const cls = (name) => (classUIDs[name] ||= push({ $classes: ARCHIVE_CLASSES[name], $classname: name }));
  function enc(v) {
    if (v && v.$class === 'LXWrappedCurve') {
      const o = { curveData: null, $class: null };
      const u = push(o);
      o.curveData = push(curveBytes(v.curve));
      o.$class = cls('LXWrappedCurve');
      return u;
    }
    if (v && v.$class === 'LXExtendedColor') {
      const o = {};
      const u = push(o);
      const c = { Cmps: new Uint8Array(v.rgb.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255))), $class: null };
      o.$class = null;
      o.color = push(c);
      c.$class = cls('LXRGBColor');
      Object.assign(o, { colorTemperature: real(0), warmWhite: real(0), coolWhite: real(v.white || 0), ultraviolet: real(0), amber: real(v.amber || 0), lime: real(0), greenSaturation: real(0), xfadeToColor: real(1) });
      o.$class = cls('LXExtendedColor');
      return u;
    }
    if (Array.isArray(v)) {
      const o = { 'NS.objects': [], $class: null };
      const u = push(o);
      o['NS.objects'] = v.map(enc);
      o.$class = cls('NSArray');
      return u;
    }
    if (v && typeof v === 'object' && !(v instanceof Uint8Array) && v.constructor === Object) {
      const o = { 'NS.keys': [], 'NS.objects': [], $class: null };
      const u = push(o);
      for (const [k, x] of Object.entries(v)) { o['NS.keys'].push(push(k)); o['NS.objects'].push(enc(x)); }
      o.$class = cls('NSDictionary');
      return u;
    }
    return push(v); // string, Real, int, bool
  }
  const root = enc(rootDict);
  return writeBplist({ $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root }, $objects: objects });
}

function curveBytes(curve) {
  return writeBplist({
    controlPoints: curve.points.map(([x, y]) => ({ x: real(x), y: real(y) })),
    segmentTypes: curve.curved.map((c) => (c ? { curved: {} } : { straight: {} })),
  });
}

// ---- static values ----------------------------------------------------------------------------------------------

const packColor = ([r, g, b]) => Math.round(r * 65535) * 2 ** 32 + Math.round(g * 65535) * 65536 + Math.round(b * 65535);
// CMY-mixing fixtures store their colour as C, M, Y under tag 2 (bits 48+), as Lightkey's own presets do;
// a plain RGB value leaves them open white.
const isCMY = (fx) => !!fx.per?.has.has('cyan') && !fx.per.has.has('red');
const packFixtureColor = (fx, rgb) => (isCMY(fx) ? 2 * 2 ** 48 + packColor(rgb.map((x) => 1 - x)) : packColor(rgb));
const DEG = Math.PI / 180;

function nearestWheelColor(fx, rgb) {
  let best = null, bestD = Infinity;
  for (const c of fx.per?.channels || []) {
    if (c.attr !== 'colorWheel') continue;
    for (const r of c.ranges || []) {
      if (!r.color) continue;
      const d = (r.color[0] - rgb[0]) ** 2 + (r.color[1] - rgb[1]) ** 2 + (r.color[2] - rgb[2]) ** 2;
      if (d < bestD) { bestD = d; best = r.color; }
    }
  }
  return best;
}

export const can = {
  color: (fx) => !!fx.per?.hasColor || !!fx.per?.has.has('colorWheel'),
  pantilt: (fx) => !!fx.per?.hasPanTilt,
  zoom: (fx) => !!fx.per?.zoom,
  intensity: (fx) => !!fx.per && (fx.per.has.has('dim') || fx.per.hasColor),
};

function containerFor(fx, look, extraIntensity, baseColor = null) {
  const per = fx.per;
  const feats = [];
  const fixture = {};
  const nseg = Math.max(1, per?.segments || 1);
  const seg = {};
  const intensity = look.intensity ?? (extraIntensity ? 1 : null);
  const color = look.color || baseColor;
  if (intensity != null && can.intensity(fx)) {
    feats.push('Intensity');
    seg.intensity = real(intensity);
    if (per.has.has('strobe')) { feats.push('Shutter'); seg.shutterState = 1; }
  }
  if (color && per?.hasColor) {
    feats.push('Color');
    seg.color = [packFixtureColor(fx, color)];
    seg.xfadeToColor = real(1);
    if (per.has.has('white')) seg.coolWhite = real(0);
    if (per.has.has('amber')) seg.amber = real(0);
  } else if (color && per?.has.has('colorWheel')) {
    const w = nearestWheelColor(fx, color);
    if (w) {
      feats.push('ColorWheel0');
      const p = packColor(w);
      fixture.color0 = { split: { _0: [{ component: { _0: [p] } }, { component: { _0: [p] } }] } };
    }
  }
  if (look.position && per?.hasPanTilt) {
    feats.push('PanTilt');
    seg.panAngle = real(look.position.pan * DEG);
    seg.tiltAngle = real(look.position.tilt * DEG);
  }
  if (look.zoom != null && per?.zoom) {
    feats.push('Zoom');
    fixture.zoomAngle = real(per.zoom.minAngle + look.zoom * (per.zoom.maxAngle - per.zoom.minAngle));
  }
  if (!feats.length) return null;
  return { definedFeatures: feats, fixtureContainer: fixture, segmentContainers: Array.from({ length: nseg }, () => ({ ...seg })) };
}

// ---- compile ------------------------------------------------------------------------------------------------------

/**
 * look: { fixtures: [fixture model objects], intensity: 0–1 | null, color: [r,g,b] | null,
 *         position: { pan, tilt } (degrees) | null, zoom: 0–1 | null,
 *         effects: [{ id, rate, order, colors: [[r,g,b]…], size: 's'|'m'|'l' }] }
 * Returns { bytes (fpStore), paths: [{ id, name, points }] , summary } — paths must be added to the project.
 */
export function compileLook(look, bpm, newId) {
  const fixtures = look.fixtures;
  const effects = [];
  const paths = [];
  const lit = new Set(); // fixtures that need intensity so an effect is visible
  // Fixtures under a colour effect need a static colour too: without one Lightkey shows a fallback colour
  // (blue) instead of the effect. Lightkey's own presets always pair a colour chase with a static colour.
  const baseColor = new Map();
  const summary = [];

  for (const e of look.effects) {
    const def = EFFECTS.find((d) => d.id === e.id);
    if (!def) continue;
    const members = fixtures.filter((fx) => (def.needs ? can[def.needs](fx) : can.intensity(fx)));
    if (!members.length) continue;
    const pixels = orderPixels(members, e.order || def.order);
    const n = pixelCount(pixels);
    const dur = secondsFor(e.rate || def.rate, bpm);
    const params = {};
    let effectClass;
    if (def.make === 'curve') {
      effectClass = 3000;
      params.duration = real(dur);
      // Offset per pixel: spread effects pass across all pixels once per cycle; odd/even is half a cycle.
      params.shift0 = real(def.half || (e.order || def.order) === 'alt' ? 0.5 : n > 1 && def.spread ? 1 / n : 0);
      params.wrappedCurve0 = { $class: 'LXWrappedCurve', curve: CURVES[def.curve] };
    } else if (def.make === 'chase') {
      effectClass = 1000;
      const colors = (e.colors?.length ? e.colors : [[1, 0, 0], [0, 0, 1]]).map((rgb) => ({ $class: 'LXExtendedColor', rgb }));
      params.pattern = 1000;
      params.values = colors;
      params.duration = real(dur);
      // chaseShift is relative to one sample: a full pass across all pixels over the cycle.
      const alt = def.half || (e.order || def.order) === 'alt';
      params.chaseShift = real(alt ? 1 : n > 1 && def.spread ? colors.length / n : 0);
      params.chaseSmoothness = real(def.smooth ?? 1);
    } else if (def.make === 'path') {
      effectClass = 2000;
      // e.pathId: use a movement path already in the project (with e.phasing / e.seconds / e.mirrorPan as stored
      // alongside it) instead of generating one around the base position.
      let id = e.pathId;
      if (!id) {
        const base = look.position || { pan: 0, tilt: 30 };
        id = newId();
        paths.push({ id, name: `LW ${def.name} ${e.size || 'm'} ${Math.round(base.pan)}/${Math.round(base.tilt)}`, points: pathPoints(def.path, base, SIZES[e.size || 'm']) });
      }
      params.mirrorPan = !!e.mirrorPan;
      params.movementPathIdentifier = id;
      params.phasing = real(e.phasing ?? (def.half || (e.order || def.order) === 'alt' ? 0.5 : n > 1 && def.spread ? 1 / n : 0));
      params.panOffset = real(0);
      params.duration = real(e.seconds ?? dur);
    }
    if (def.feature === 'Intensity') for (const fx of members) lit.add(fx);
    if (def.feature === 'Color') {
      const first = (e.colors?.length ? e.colors : [[1, 0, 0]])[0];
      for (const fx of members) if (!baseColor.has(fx)) baseColor.set(fx, first);
    }
    effects.push({
      effectClass, feature: def.feature,
      extent: Object.fromEntries(members.map((fx) => [fx.uuid, { all: {} }])),
      parameters: archive(params),
      // Fixtures sharing a pixel number are listed together under that number (Lightkey keeps only one entry
      // per number, as its own re-save of a test file showed).
      pixelOrder: { type: 524288, orderedPixelRefs: [...new Set(pixels.map((p) => p.pos))].sort((a, b) => a - b).flatMap((pos) => [real(pos), pixels.filter((p) => p.pos === pos).map((p) => ({ fixtureID: p.fx.uuid }))]) },
      pixelOrderGranularity: 0,
    });
    summary.push(`${def.name} ${RATES.find((r) => r.id === (e.rate || def.rate)).label} = ${dur.toFixed(2)}s`);
  }

  const umbrellaContainers = {};
  for (const fx of fixtures) {
    const c = containerFor(fx, look, lit.has(fx), baseColor.get(fx));
    if (c) umbrellaContainers[fx.uuid] = c;
  }
  const store = { isMutable: false, umbrellaContainers };
  if (effects.length) store.effects = effects;
  return { bytes: writeBplist(store), paths, summary };
}

function pathPoints(kind, base, A) {
  const p0 = base.pan * DEG, t0 = base.tilt * DEG, a = A * DEG;
  const ring = (n, f) => Array.from({ length: n }, (_, i) => f((i / n) * 2 * Math.PI));
  switch (kind) {
    case 'circle': return ring(8, (u) => [p0 + a * Math.cos(u), t0 + a * 0.6 * Math.sin(u)]);
    case 'eight': return ring(8, (u) => [p0 + a * Math.sin(u), t0 + a * 0.45 * Math.sin(2 * u)]);
    case 'pan': return [[p0 - a, t0], [p0 + a, t0]];
    case 'tilt': return [[p0, t0 - a * 0.6], [p0, t0 + a * 0.6]];
    default: return [[p0, t0]];
  }
}

/** Decode a compiled store the same way a saved project is read (for the live preview). */
export function previewStore(bytes) {
  return decodeNested(bytes);
}
