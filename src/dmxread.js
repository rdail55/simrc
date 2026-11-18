// Live DMX → fixture state: the inverse of profiles.js writeDMX(). Works for Lightkey profiles and GDTF profiles
// (gdtf.js), and produces the state shape engine.js uses, so the 3D stage draws it the same way.
const SHUTTER_CODE = { closed: 0, open: 1, strobe: 2, pulse: 3, rampUp: 4, random: 5 };
const RAD = Math.PI / 180;

export function emptyState(per) {
  const n = Math.max(1, per?.segments || 1);
  return {
    seg: Array.from({ length: n }, () => ({ intensity: 0, rgb: [1, 1, 1], white: 0, amber: 0, uv: 0, warmWhite: 0, shutter: 1, strobeSpeed: 0 })),
    pan: 0, tilt: 0, zoomAngle: null, focus: 0.5, gobo: [null, null], wheel: null, fog: 0, custom: {},
  };
}

const inside = (ranges, v) => ranges?.find((r) => v >= r.from && v <= r.to);

/**
 * Read one fixture from DMX. `get(i)` returns the byte at 0-based channel i of the fixture's footprint
 * (so fixtures that cross a universe boundary work). Returns a fresh state.
 */
export function readDMX(get, profile, per, st = emptyState(per)) {
  const chans = per.channels;
  const fine = {};
  for (const c of chans) if (/Fine$/.test(c.attr)) fine[`${c.attr.slice(0, -4)}:${c.segment ?? ''}`] = c.index;
  const val16 = (c) => {
    const f = fine[`${c.attr}:${c.segment ?? ''}`];
    return f != null ? ((get(c.index) << 8) | get(f)) / 65535 : get(c.index) / 255;
  };
  const hasDim = per.has.has('dim');
  const segDim = new Set(chans.filter((c) => c.attr === 'dim' && c.segment != null).map((c) => c.segment));
  const hasMaster = chans.some((c) => c.attr === 'dim' && c.segment == null);
  let master = 1;
  const col = st.seg.map(() => ({ r: null, g: null, b: null, c: null, m: null, y: null, w: 0, ww: 0, a: 0, uv: 0, dim: null }));
  for (const c of chans) {
    const v = get(c.index);
    const s = col[c.segment ?? 0] || col[0];
    const seg = st.seg[c.segment ?? 0] || st.seg[0];
    switch (c.attr) {
      case 'dim': if (c.segment == null) master = val16(c); else s.dim = val16(c); break;
      case 'red': s.r = v / 255; break;
      case 'green': s.g = v / 255; break;
      case 'blue': s.b = v / 255; break;
      case 'cyan': s.c = v / 255; break;
      case 'magenta': s.m = v / 255; break;
      case 'yellow': s.y = v / 255; break;
      case 'white': s.w = v / 255; break;
      case 'warmWhite': s.ww = v / 255; break;
      case 'amber': s.a = v / 255; break;
      case 'uv': s.uv = v / 255; break;
      case 'pan': st.pan = ((val16(c) - 0.5) * profile.panRange) * RAD; break;
      case 'tilt': st.tilt = ((val16(c) - 0.5) * profile.tiltRange + (profile.tiltCenter || 0)) * RAD; break;
      case 'zoom': {
        if (c.minAngle == null) break;
        const r = c.settings[0] || { from: 0, to: 255 };
        const f = Math.min(1, Math.max(0, (v - r.from) / ((r.to - r.from) || 1)));
        st.zoomAngle = c.minAngle + f * ((c.maxAngle ?? c.minAngle) - c.minAngle);
        break;
      }
      case 'focus': st.focus = val16(c); break;
      case 'fog': st.fog = v / 255; break;
      case 'strobe': {
        const r = inside(c.ranges, v);
        if (!r) break;
        const targets = c.segment == null ? st.seg : [seg];
        const f = (v - r.from) / ((r.to - r.from) || 1);
        const speed = (r.reverse ? 1 - f : f) * 20;
        // Profiles with no "open" range (e.g. Lightkey's SlimPAR) write strobe speed 0 for "no strobe".
        const kind = r.kind !== 'open' && speed < 0.5 && !c.ranges.some((x) => x.kind === 'open') ? 'open' : r.kind;
        for (const t of targets) {
          t.shutter = SHUTTER_CODE[kind] ?? 1;
          t.strobeSpeed = speed;
        }
        break;
      }
      case 'colorWheel': { const r = inside(c.ranges, v); if (r?.color) st.wheel = r.color; else if (r) st.wheel = null; break; }
      case 'gobo': { const r = inside(c.ranges, v); st.gobo[c.wheel || 0] = r?.id || null; break; }
      default: break;
    }
  }
  st.seg.forEach((seg, i) => {
    const s = col[i];
    let rgb = [s.r, s.g, s.b];
    if (s.c != null || s.m != null || s.y != null) rgb = [1 - (s.c ?? 0), 1 - (s.m ?? 0), 1 - (s.y ?? 0)];
    const hasRGB = rgb.some((x) => x != null);
    rgb = rgb.map((x) => x ?? 0);
    const extra = Math.max(s.w, s.ww, s.a, s.uv);
    let intensity = (hasMaster ? master : 1) * (segDim.size ? (s.dim ?? 0) : 1);
    if (!hasDim) {
      // LED fixture without a dimmer: brightness lives in the colour channels.
      const peak = Math.max(...rgb, extra);
      intensity = peak;
      if (peak > 0) { rgb = rgb.map((x) => x / peak); s.w /= peak; s.ww /= peak; s.a /= peak; s.uv /= peak; }
    }
    seg.intensity = intensity;
    seg.rgb = hasRGB ? rgb : [0, 0, 0];
    seg.white = s.w; seg.warmWhite = s.ww; seg.amber = s.a; seg.uv = s.uv;
    if (!per.hasColor && !hasRGB) { seg.rgb = [1, 1, 1]; }
  });
  return st;
}
