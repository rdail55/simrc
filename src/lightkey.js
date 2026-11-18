// Read a Lightkey project (.lightkeyproj, an NSKeyedArchiver binary plist) into a plain model the player uses:
// patch (universes, fixtures, profiles), stage drawing, preset palette, live pages (buttons, faders, frames,
// cuelists), and movement paths. The format is undocumented; this follows what Lightkey 5.4 – 6.x write.
import { unarchive, decodeNested, parsePoint, parseRect } from './nska.js';
import { convertProfile, rgbFromCmps } from './profiles.js';

// ---- small decoders -----------------------------------------------------------------------------------------

const ascii = (b) => (b instanceof Uint8Array ? String.fromCharCode(...b).replace(/\0/g, '') : String(b ?? ''));

/** NSColor → [r, g, b, a] (0–1). Handles calibrated white and RGB; anything else falls back to grey. */
export function nsColor(c) {
  if (!c) return null;
  if (c.NSRGB) { const v = ascii(c.NSRGB).trim().split(/\s+/).map(Number); return [v[0] || 0, v[1] || 0, v[2] || 0, v[3] ?? 1]; }
  if (c.NSWhite) { const v = ascii(c.NSWhite).trim().split(/\s+/).map(Number); return [v[0] || 0, v[0] || 0, v[0] || 0, v[1] ?? 1]; }
  if (c.NSComponents) { const v = ascii(c.NSComponents).trim().split(/\s+/).map(Number); return v.length >= 3 ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0], v[0], v[0], v[1] ?? 1]; }
  return [0.5, 0.5, 0.5, 1];
}

/** 48-bit packed colour used in preset stores: 16 bits each of red, green, blue. Tag 2 (bits 48+) = C, M, Y. */
export function unpackColor(n) {
  const v = typeof n === 'bigint' ? Number(n) : n;
  const r = Math.floor(v / 2 ** 32) % 65536, g = Math.floor(v / 65536) % 65536, b = v % 65536;
  const rgb = [r / 65535, g / 65535, b / 65535];
  return Math.floor(v / 2 ** 48) === 2 ? rgb.map((x) => 1 - x) : rgb;
}

function decodeCurve(wc) {
  const data = wc?.curveData;
  if (!data) return null;
  try {
    const c = decodeNested(data);
    const points = (c.controlPoints || []).map((p) => [p.x, p.y]);
    const curved = (c.segmentTypes || []).map((t) => 'curved' in t);
    return points.length ? { points, curved } : null;
  } catch { return null; }
}

function decodeExtendedColor(c) {
  if (!c) return null;
  if (typeof c === 'number') return c;
  const rgb = rgbFromCmps(c.color) || (c.color?.$class === 'LXSplitColor' ? rgbFromCmps(c.color.leftColor) : null) || [1, 1, 1];
  return { rgb, white: c.coolWhite || 0, amber: c.amber || 0, uv: c.ultraviolet || 0, warmWhite: c.warmWhite || 0 };
}

function decodeEffectParams(raw) {
  let p;
  try { p = raw instanceof Uint8Array ? decodeNested(raw) : raw; } catch { return {}; }
  const out = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (k.startsWith('wrappedCurve')) out.curves = { ...(out.curves || {}), [Number(k.slice(12))]: decodeCurve(v) };
    else if (k === 'values') out.values = (v || []).map(decodeExtendedColor);
    else if (k === 'stops') out.stops = Object.entries(v || {}).sort((a, b) => a[0] - b[0]).map(([, s]) => [s.panAngle || 0, s.tiltAngle || 0]);
    else out[k] = v;
  }
  return out;
}

// Lightkey ≤ 5.1 named effect classes; newer files store a number.
const LEGACY_EFFECT = { LXPatternEffect: 1000, LXMovementEffect: 2000, LXCurveEffect: 3000 };

function decodeEffect(e) {
  const extent = Array.isArray(e.fixtureUUIDs) ? e.fixtureUUIDs : Object.keys(e.extent || {});
  // Fixture order. A custom order (orderedPixelRefs: [number, [{fixtureID}], …]) gives each fixture a pixel
  // number; fixtures sharing a number act as one pixel and gaps are allowed (Lightkey User Guide, "Custom Order").
  const pos = {};
  const refs = e.pixelOrder?.orderedPixelRefs;
  if (Array.isArray(refs)) {
    for (let i = 0; i + 1 < refs.length; i += 2) for (const r of refs[i + 1] || []) if (pos[r.fixtureID] == null) pos[r.fixtureID] = Number(refs[i]);
  }
  const legacyRefs = e.pixelOrder?.pixelRefs;
  if (Array.isArray(legacyRefs)) [...new Set(legacyRefs.map((r) => r.fixtureUUID))].forEach((id, i) => { if (pos[id] == null) pos[id] = i; });
  const ordered = [...extent].sort((a, b) => (pos[a] ?? extent.indexOf(a) + 1e6) - (pos[b] ?? extent.indexOf(b) + 1e6));
  const hasPos = Object.keys(pos).length > 0;
  // Unlisted fixtures follow the listed ones.
  let next = hasPos ? Math.max(...Object.values(pos)) + 1 : 0;
  for (const id of ordered) if (pos[id] == null) pos[id] = hasPos ? next++ : ordered.indexOf(id);
  return {
    feature: e.feature,
    cls: typeof e.effectClass === 'number' ? e.effectClass : LEGACY_EFFECT[e.effectClass] ?? String(e.effectClass),
    extent: ordered,
    pos,
    pixels: new Set(Object.values(pos)).size,
    params: decodeEffectParams(e.parameters),
  };
}

/** A preset store (fpStore bytes) → { containers, effects } in the player's form. */
export function decodeStoreBytes(bytes) {
  return decodePresetStore({ fpStore: bytes });
}

function decodePresetStore(preset) {
  const raw = preset.fpStore;
  if (raw instanceof Uint8Array) {
    try {
      const fp = decodeNested(raw);
      const containers = fp.umbrellaContainers || {};
      // Lightkey 5.4-era stores: { containers: { id: { content, subcontainers: [{ content }] } } }, no feature list.
      for (const [fid, c] of Object.entries(fp.containers || {})) {
        const fixture = c.content || {};
        const segments = (c.subcontainers || []).map((s) => s.content || {});
        containers[fid] = { definedFeatures: inferFeatures(fixture, segments), fixtureContainer: fixture, segmentContainers: segments.length ? segments : [{}] };
      }
      return { containers, effects: (fp.effects || []).map(decodeEffect) };
    } catch (err) {
      return { containers: {}, effects: [], error: String(err) };
    }
  }
  if (preset.valuesStore) return decodeLegacyStore(preset.valuesStore);
  return { containers: {}, effects: [] };
}

const packColor = ([r, g, b]) => Math.round(r * 65535) * 2 ** 32 + Math.round(g * 65535) * 65536 + Math.round(b * 65535);
const LEGACY_FEATURES = [
  ['intensity', 'Intensity'], ['shutterState', 'Shutter'], ['color', 'Color'], ['panAngle', 'PanTilt'], ['zoomAngle', 'Zoom'],
  ['gobo0', 'GoboWheel0'], ['gobo1', 'GoboWheel1'], ['color0', 'ColorWheel0'], ['fogAmount', 'Fog'], ['focus', 'Focus'],
];

/** Older stores don't list which properties a preset defines; infer it from the values present. */
function inferFeatures(fixture, segments) {
  const keys = new Set([...Object.keys(fixture), ...segments.flatMap((s) => Object.keys(s))]);
  const feats = LEGACY_FEATURES.filter(([k]) => keys.has(k)).map(([, f]) => f);
  for (const k of keys) if (k.startsWith('custom--')) feats.push(k);
  return feats;
}

/** Lightkey ≤ 5.1 kept preset values as archived objects (LXPersistentFPStore); convert to the newer layout. */
function decodeLegacyStore(vs) {
  const containers = {};
  const effects = new Set();
  for (const [fid, c] of Object.entries(vs.fixtureValuesDict || {})) {
    if (!c) continue;
    const fixture = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === '$class' || k === 'beamValues' || k === 'effectsDict') continue;
      if (k === 'color0' && v?.$class === 'LXSplitColor') {
        const l = rgbFromCmps(v.leftColor), r = rgbFromCmps(v.rightColor) || l;
        fixture.color0 = { split: { _0: [{ component: { _0: [packColor(l || [1, 1, 1])] } }, { component: { _0: [packColor(r || [1, 1, 1])] } }] } };
      } else if (v && typeof v === 'object' && v.$class === 'LXGobo') fixture[k] = { identifier: v.identifier, wheelIndex: v.wheelIndex };
      else fixture[k] = v;
    }
    const segments = (c.beamValues || []).map((b) => {
      const s = {};
      for (const [k, v] of Object.entries(b || {})) {
        if (k === '$class') continue;
        if (k === 'color') {
          let rgb = rgbFromCmps(v) || [1, 1, 1];
          if (v?.$class === 'LXCMYColor') rgb = rgb.map((x) => 1 - x);
          s.color = [packColor(rgb)];
        } else s[k] = v;
      }
      return s;
    });
    containers[fid] = { definedFeatures: inferFeatures(fixture, segments), fixtureContainer: fixture, segmentContainers: segments.length ? segments : [{}] };
    for (const anchors of Object.values(c.effectsDict || {})) for (const a of anchors || []) if (a?.effect) effects.add(a.effect);
  }
  return { containers, effects: [...effects].map(decodeEffect), legacy: true };
}

// ---- project ------------------------------------------------------------------------------------------------

export function readLightkey(bytes, fileName = 'Project.lightkeyproj') {
  const d = unarchive(bytes);
  const warnings = [];

  // Profiles and patch.
  const profiles = new Map();
  for (const p of d.fixtureProfiles || []) profiles.set(p.UUID, convertProfile(p));

  const universes = [];
  const fixtures = [];
  const fixtureById = new Map();
  for (const u of d.universes || []) {
    universes.push({ uuid: u.UUID, index: u.index || 1, label: u.label || '', device: u.lastKnownDeviceName || '' });
    for (const f of u.fixtures || []) {
      const profile = profiles.get(f.fixtureProfileUUID);
      if (!profile) continue;
      const per = profile.personalities[f.personalityIndex || 0] || profile.personalities[0];
      const fx = {
        uuid: f.UUID, name: f.shortName || profile.name, profile, per,
        universe: u.index || 1, address: (f.address || 0) + 1, footprint: per?.footprint || 0,
        stage: null, index: fixtures.length,
      };
      fixtures.push(fx);
      fixtureById.set(fx.uuid, fx);
    }
  }

  // Stage (Lightkey's Preview): fixture positions and the drawing around them. Canvas space is y-up.
  const shapes = [];
  const stageGroups = [];
  for (const stage of d.stages || []) {
    for (const item of stage.items || []) {
      const center = parsePoint(item.center) || [0, 0];
      const size = parsePoint(item.unrotatedSize) || [10, 10];
      if (item.$class === 'LXFixtureStageItem') {
        const fx = item.fixture && fixtureById.get(item.fixture.UUID);
        if (fx) fx.stage = { x: center[0], y: center[1], size, angle: item.angle || 0, beamColor: rgbFromCmps(item.beamColor), panInverted: !!item.panInverted };
        continue;
      }
      shapes.push({
        kind: /Spline/.test(item.$class) ? 'spline' : /Text/.test(item.$class) ? 'text' : /Oval|Ellipse/.test(item.$class) ? 'oval' : 'rect',
        center, size, angle: item.angleCCW || 0,
        stroke: nsColor(item.strokeColor), fill: nsColor(item.fillColor),
        strokeOpacity: item.strokeOpacity ?? 1, fillOpacity: item.fillOpacity ?? 0, opacity: item.opacity ?? 1,
        strokeWidth: item.strokeWidth ?? 1, strokeType: item.strokeType ?? 1,
        knots: Array.isArray(item.splineKnots) ? item.splineKnots.filter(Boolean) : null,
        text: typeof item.contents === 'string' ? item.contents : null,
      });
    }
    for (const g of stage.groups || []) {
      const members = (g.members || []).map((m) => m.fixture && fixtureById.get(m.fixture.UUID)).filter(Boolean);
      if (members.length) stageGroups.push(members);
    }
  }

  // Presets: every LXPreset object, decoded once (cues and the palette share the same objects).
  const presets = new Map();
  const presetOf = (p) => {
    if (!p || !p.UUID) return null;
    if (!presets.has(p.UUID)) {
      const store = decodePresetStore(p);
      if (store.legacy && !warnings.includes('legacy')) warnings.push('legacy');
      presets.set(p.UUID, { uuid: p.UUID, name: p.name || 'Preset', ...store });
    }
    return presets.get(p.UUID);
  };

  function paletteNode(n) {
    if (!n) return null;
    if (n.$class === 'LXPreset') return { type: 'preset', preset: presetOf(n), name: n.name };
    return {
      type: 'group', uuid: n.UUID, name: n.name || 'Folder', exclusive: !!n.presetsAreMutuallyExclusive,
      children: (n.childNodes || []).map(paletteNode).filter(Boolean),
    };
  }
  const palette = paletteNode(d.rootPresetGroup) || { type: 'group', name: 'Palette', children: [] };

  // Cues.
  const cues = new Map();
  const cueOf = (c) => {
    if (!c || !c.UUID) return null;
    if (!cues.has(c.UUID)) {
      const own = (c.orphanPresetsGroup?.childNodes || []).filter((n) => n.$class === 'LXPreset');
      const list = [...(c.presets || []), ...own].map(presetOf).filter(Boolean);
      cues.set(c.UUID, {
        uuid: c.UUID, name: c.name || 'Cue',
        presets: [...new Set(list)],
        fadeIn: c.fadeInDuration ?? c.fadeDuration ?? 0.5,
        fadeOut: c.fadeOutDuration ?? c.fadeDuration ?? 0.5,
        hold: c.holdDuration ?? -1,
        priority: c.priority ?? 5,
        intensity: c.intensity ?? 1,
        speed: c.metaModifiers?.speed ?? 1,
        startup: !!c.activateAtStartup,
      });
    }
    return cues.get(c.UUID);
  };

  // Live pages.
  const pages = [];
  for (const panel of d.livePanels || []) {
    const items = [];
    const seen = new Set();
    const addButton = (b, frame = null) => {
      if (!b || seen.has(b)) return;
      seen.add(b);
      const cue = cueOf(b.cue);
      if (!cue) return;
      items.push({
        kind: b.type === 1 ? 'fader' : 'button', rect: parseRect(b.rect), cue,
        flash: b.behavior === 1, vertical: !!b.vertical, color: b.colorName || null, frame,
      });
    };
    for (const it of panel.items || []) {
      if (it.$class === 'LXCpanButton') addButton(it);
      else if (it.$class === 'LXCpanFrame') {
        const frame = {
          kind: 'frame', uuid: it.UUID, name: it.name || '', rect: parseRect(it.rect), priority: it.priority ?? 5,
          speed: it.metaModifiers?.speed ?? 1, steps: !!(it.showsForwardButton || it.showsBackButton), buttons: [],
        };
        items.push(frame);
        for (const m of it.members || []) {
          const before = items.length;
          addButton(m, frame);
          if (items.length > before) frame.buttons.push(items[items.length - 1]);
        }
        frame.buttons.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
      } else if (it.$class === 'LXCpanCuelist') {
        const list = [];
        const walk = (nodes) => {
          for (const n of nodes || []) {
            const cue = cueOf(n.cue);
            if (cue) list.push({ cue, name: n.name || cue.name, ticked: n.ticked !== false });
            walk(n.childNodes);
          }
        };
        walk(it.rootCueGroup?.childNodes);
        items.push({ kind: 'cuelist', rect: parseRect(it.rect), priority: it.priority ?? 5, loops: !!it.loops, cues: list, name: it.name || 'Cuelist' });
      } else if (it.rect) {
        const text = typeof it.contents === 'string' ? it.contents : typeof it.text === 'string' ? it.text : typeof it.name === 'string' ? it.name : '';
        items.push({ kind: 'label', rect: parseRect(it.rect), text, cls: it.$class });
      }
    }
    pages.push({ uuid: panel.UUID, name: panel.name || 'Page', fade: panel.fadeDuration ?? 1, priority: panel.priority ?? 5, items });
  }

  // Movement paths (pan/tilt key positions, radians).
  const movementPaths = new Map();
  for (const mp of d.movementPaths || []) {
    movementPaths.set(mp.identifier, {
      name: mp.name, smooth: mp.interpolationMethod !== 0,
      points: (mp.keyPositions || []).map((k) => [k.panAngle || 0, k.tiltAngle || 0]),
    });
  }

  const snapshot = d.stageSnapshotData instanceof Uint8Array ? d.stageSnapshotData : null;

  return {
    fileName,
    name: fileName.replace(/\.lightkeyproj$/i, ''),
    appVersion: d.appVersion || '?',
    universes, profiles: [...profiles.values()], fixtures, fixtureById,
    stage: { shapes, groups: stageGroups, snapshot },
    palette, presets, cues, pages, movementPaths,
    panAnglesIncludeInversion: !!d.panAnglesIncludeInversion,
    warnings,
  };
}
