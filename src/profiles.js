// Lightkey fixture profiles: capabilities → channel list, and fixture state → DMX bytes.
// Lightkey stores DMX range bounds as signed chars (-128..127), so -1 means 255.

const u8 = (v) => (v ?? 0) & 0xff;

export function rgbFromCmps(c) {
  const b = c?.Cmps;
  if (!b || b.length < 3) return null;
  return [b[0] / 255, b[1] / 255, b[2] / 255];
}

const COLOR_COMPONENTS = {
  red: 'red', green: 'green', blue: 'blue', white: 'white', amber: 'amber', uv: 'uv', ultraviolet: 'uv', lime: 'lime',
  cyan: 'cyan', magenta: 'magenta', yellow: 'yellow', 'warm white': 'warmWhite', warmwhite: 'warmWhite',
  'cool white': 'white', coolwhite: 'white', 'cold white': 'white', coldwhite: 'white', indigo: 'indigo',
};

// Lightkey shutter modes seen in profiles and preset stores.
const SHUTTER_KIND = { 0: 'closed', 1: 'open', 2: 'strobe', 3: 'pulse', 4: 'rampUp', 5: 'random' };

function settingsOf(cap) {
  return (cap.settings || []).map((s) => {
    const r = s.$0 || {};
    return { from: u8(r.$0), to: u8(r.$1 ?? -1), params: s.params || {} };
  });
}

function mapCapability(cap) {
  const cls = cap.$class.replace(/^LX/, '').replace(/Capability$/, '');
  const settings = settingsOf(cap);
  const base = { cls, settings, segment: cap.beamIndexes?.[0] ?? null };
  switch (cls) {
    case 'Intensity': return { ...base, attr: 'dim' };
    case 'IntensityFine': return { ...base, attr: 'dimFine' };
    case 'Pan': return { ...base, attr: 'pan' };
    case 'PanFine': return { ...base, attr: 'panFine' };
    case 'Tilt': return { ...base, attr: 'tilt' };
    case 'TiltFine': return { ...base, attr: 'tiltFine' };
    case 'Zoom': return { ...base, attr: 'zoom', minAngle: settings[0]?.params.minAngle, maxAngle: settings[0]?.params.maxAngle };
    case 'ZoomFine': return { ...base, attr: 'zoomFine' };
    case 'Focus': return { ...base, attr: 'focus' };
    case 'FocusFine': return { ...base, attr: 'focusFine' };
    case 'Iris': return { ...base, attr: 'iris' };
    case 'Frost': return { ...base, attr: 'frost' };
    case 'Fog': return { ...base, attr: 'fog' };
    case 'PanTiltSpeed': return { ...base, attr: 'speed' };
    case 'ColorComponent': {
      const name = String(settings[0]?.params.componentName || '');
      const fine = /fine$/i.test(name);
      const key = name.replace(/\s*fine$/i, '').toLowerCase();
      const attr = COLOR_COMPONENTS[key] ?? COLOR_COMPONENTS[key.replace(/\s+/g, '')];
      return attr ? { ...base, attr: fine ? `${attr}Fine` : attr, name } : { ...base, attr: 'raw', name };
    }
    case 'ShutterStrobe':
      return { ...base, attr: 'strobe', ranges: settings.map((s) => ({ from: s.from, to: s.to, kind: SHUTTER_KIND[s.params.mode] || `mode${s.params.mode}`, reverse: s.params.transformation === -1 })) };
    case 'Gobo':
      return { ...base, attr: 'gobo', ranges: settings.map((s) => ({ from: s.from, to: s.to, id: String(s.params.goboIdentifier || ''), shake: !!s.params.shaking })) };
    case 'GoboRotation': case 'GoboAngle': return { ...base, attr: 'goboRot' };
    case 'GoboAngleFine': return { ...base, attr: 'goboRotFine' };
    case 'ColorWheel':
      return {
        ...base, attr: 'colorWheel',
        ranges: settings.map((s) => {
          const c = s.params.color;
          const color = c?.$class === 'LXSplitColor' ? rgbFromCmps(c.leftColor) : rgbFromCmps(c);
          return { from: s.from, to: s.to, color, mode: s.params.mode };
        }),
      };
    case 'Command': return { ...base, attr: 'control', name: settings[0]?.params.name || 'Command' };
    case 'Custom': return { ...base, attr: 'custom', name: cap.customName || 'Custom' };
    default: return { ...base, attr: 'raw', name: cap.customName || cls };
  }
}

const TYPE_NAMES = { 0: 'other', 1: 'color', 2: 'mover', 70: 'fog' };

export function convertProfile(p) {
  const personalities = (p.personalities || []).map((per, pi) => {
    const footprint = per.footprint || 0;
    const channels = Array.from({ length: footprint }, (_, i) => ({ index: i, attr: 'raw', name: `Ch ${i + 1}`, settings: [] }));
    let segments = 1;
    for (const cap of per.capabilities || []) {
      const ch = cap.channel;
      if (ch == null || ch >= footprint) continue;
      const m = mapCapability(cap);
      if (m.segment != null) segments = Math.max(segments, m.segment + 1);
      if (channels[ch].attr === 'raw' && !channels[ch].cls) channels[ch] = { index: ch, ...m };
      else (channels[ch].also ||= []).push(m.attr);
    }
    let gobos = 0, wheels = 0;
    for (const c of channels) {
      if (c.attr === 'gobo') c.wheel = gobos++;
      if (c.attr === 'colorWheel') c.wheel = wheels++;
    }
    const attrs = new Set(channels.map((c) => c.attr));
    return {
      index: pi,
      name: per.customName || `${footprint}ch`,
      footprint,
      channels,
      segments,
      has: attrs,
      hasColor: ['red', 'green', 'blue', 'cyan'].some((a) => attrs.has(a)),
      hasPanTilt: attrs.has('pan') || attrs.has('tilt'),
      zoom: channels.find((c) => c.attr === 'zoom' && c.minAngle != null),
    };
  });
  return {
    uuid: p.UUID,
    name: p.name || 'Fixture',
    manufacturer: p.manufacturer || '',
    kind: TYPE_NAMES[p.type] || 'other',
    panRange: p.panRange || 540,
    tiltRange: p.tiltRange || 270,
    tiltCenter: p.tiltCenter || 0,
    beamSpread: p.beamSpread || 0,
    personalities,
  };
}

// ---- state → DMX --------------------------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const RAD = 180 / Math.PI;

function put16(out, ch, fine, v) {
  const x = Math.round(clamp01(v) * 65535);
  out[ch] = x >> 8;
  if (fine != null) out[fine] = x & 0xff;
}

function inRange(r, frac) {
  return Math.round(r.from + clamp01(frac) * (r.to - r.from));
}

function nearestWheel(ranges, rgb) {
  let best = null, bestD = Infinity;
  for (const r of ranges) {
    if (!r.color) continue;
    const d = (r.color[0] - rgb[0]) ** 2 + (r.color[1] - rgb[1]) ** 2 + (r.color[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * Write one fixture's DMX into `out` (a 512-byte universe) at `start` (0-based).
 * state: { seg: [{ intensity, rgb, white, amber, uv, shutter, strobeSpeed }], pan, tilt (radians), zoomAngle, focus,
 *          gobo: [id, id], wheel: rgb | null, fog, custom: { channel: [rangeIndex, fraction] } }
 */
export function writeDMX(out, start, profile, per, state) {
  const chans = per.channels;
  const fineOf = (attr) => chans.find((c) => c.attr === attr)?.index;
  const hasDim = per.has.has('dim');
  for (const c of chans) {
    const at = start + c.index;
    if (at >= out.length) break;
    const s = state.seg[c.segment ?? 0] || state.seg[0];
    switch (c.attr) {
      case 'dim': {
        const v = c.segment == null ? Math.max(...state.seg.map((x) => x.intensity)) : s.intensity;
        const fine = fineOf('dimFine');
        put16(out, at, fine != null ? start + fine : null, v);
        break;
      }
      case 'red': case 'green': case 'blue': {
        const k = { red: 0, green: 1, blue: 2 }[c.attr];
        out[at] = Math.round(clamp01(s.rgb[k] * (hasDim ? 1 : s.intensity)) * 255);
        break;
      }
      case 'cyan': case 'magenta': case 'yellow': {
        const k = { cyan: 0, magenta: 1, yellow: 2 }[c.attr];
        out[at] = Math.round(clamp01(1 - s.rgb[k]) * 255);
        break;
      }
      case 'white': out[at] = Math.round(clamp01(s.white * (hasDim ? 1 : s.intensity)) * 255); break;
      case 'warmWhite': out[at] = Math.round(clamp01((s.warmWhite || 0) * (hasDim ? 1 : s.intensity)) * 255); break;
      case 'amber': out[at] = Math.round(clamp01(s.amber * (hasDim ? 1 : s.intensity)) * 255); break;
      case 'uv': out[at] = Math.round(clamp01(s.uv) * 255); break;
      case 'pan': {
        const fine = fineOf('panFine');
        put16(out, at, fine != null ? start + fine : null, (state.pan * RAD) / profile.panRange + 0.5);
        break;
      }
      case 'tilt': {
        const fine = fineOf('tiltFine');
        put16(out, at, fine != null ? start + fine : null, (state.tilt * RAD - profile.tiltCenter) / profile.tiltRange + 0.5);
        break;
      }
      case 'zoom': {
        if (c.minAngle == null || state.zoomAngle == null) { out[at] = 128; break; }
        const frac = (state.zoomAngle - c.minAngle) / ((c.maxAngle - c.minAngle) || 1);
        const r = c.settings[0];
        out[at] = inRange(r, frac);
        break;
      }
      case 'focus': out[at] = Math.round(clamp01(state.focus ?? 0.5) * 255); break;
      case 'fog': out[at] = Math.round(clamp01(state.fog || 0) * 255); break;
      case 'strobe': {
        const want = SHUTTER_KIND[s.shutter ?? 1] || 'open';
        const r = c.ranges.find((x) => x.kind === want) || c.ranges.find((x) => x.kind === 'open');
        if (!r) break;
        out[at] = want === 'strobe' ? inRange(r, r.reverse ? 1 - (s.strobeSpeed || 0) / 20 : (s.strobeSpeed || 0) / 20) : r.from;
        break;
      }
      case 'gobo': {
        const id = state.gobo?.[c.wheel];
        const r = (id && c.ranges.find((x) => x.id === id)) || c.ranges[0];
        if (r) out[at] = r.from;
        break;
      }
      case 'colorWheel': {
        const r = state.wheel ? nearestWheel(c.ranges, state.wheel) : c.ranges[0];
        if (r) out[at] = r.from;
        break;
      }
      case 'custom': case 'control': case 'raw': {
        const v = state.custom?.[c.index];
        const r = v && c.settings[v[0]];
        if (r) out[at] = inRange(r, v[1]);
        break;
      }
      default: break;
    }
  }
}
