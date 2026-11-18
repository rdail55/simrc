// GDTF fixture files (from GDTF Share, or inside an MVR) → the same profile shape as profiles.js convertProfile(),
// so live DMX can be decoded with dmxread.js. A .gdtf is a zip holding description.xml.
// Capture's MVR export often embeds placeholder GDTFs whose channels are all "Dimmer1…N"; `placeholder` flags those.
import { unzipSync } from 'fflate';

const COLOR = {
  ColorAdd_R: 'red', ColorRGB_Red: 'red', ColorAdd_G: 'green', ColorRGB_Green: 'green', ColorAdd_B: 'blue', ColorRGB_Blue: 'blue',
  ColorAdd_W: 'white', ColorAdd_CW: 'white', ColorAdd_WW: 'warmWhite', ColorAdd_A: 'amber', ColorAdd_RY: 'amber',
  ColorAdd_UV: 'uv', ColorSub_C: 'cyan', ColorSub_M: 'magenta', ColorSub_Y: 'yellow',
  ColorRGB_Cyan: 'cyan', ColorRGB_Magenta: 'magenta', ColorRGB_Yellow: 'yellow',
};

function attrOf(name) {
  if (!name) return 'raw';
  if (COLOR[name]) return COLOR[name];
  if (/^Dimmer$/.test(name)) return 'dim';
  if (name === 'Pan') return 'pan';
  if (name === 'Tilt') return 'tilt';
  if (name === 'Zoom') return 'zoom';
  if (/^Focus\d*$/.test(name)) return 'focus';
  if (name === 'Iris') return 'iris';
  if (/^Frost\d*$/.test(name)) return 'frost';
  if (/^Shutter\d+/.test(name) || /^Strobe(Frequency|Rate|ModeShutter|ModeStrobe)?$/.test(name)) return 'strobe';
  if (/^Color\d+$/.test(name)) return 'colorWheel';
  if (/^Gobo\d+$/.test(name)) return 'gobo';
  if (/^Gobo\d+(Pos|PosRotate|SelectSpin)/.test(name)) return 'goboRot';
  if (/^(Fog|Haze)\d*$/.test(name) || /^Fog\d*Output/.test(name)) return 'fog';
  if (/Speed/.test(name)) return 'speed';
  return 'raw';
}

// "128/1" or "32768/2" → 0–255.
function dmx8(s) {
  const [v, n] = String(s || '0/1').split('/').map(Number);
  return Math.round((v || 0) / 256 ** ((n || 1) - 1));
}

// CIE xyY (GDTF colours) → linear-ish sRGB 0–1, normalised so the brightest component is 1.
function xyYtoRGB(str) {
  const [x, y, Y = 100] = String(str || '').split(',').map(Number);
  if (!y) return null;
  const X = (x * Y) / y, Z = ((1 - x - y) * Y) / y;
  let rgb = [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
  rgb = rgb.map((v) => Math.max(0, v));
  const mx = Math.max(...rgb, 1e-6);
  return rgb.map((v) => v / mx);
}

const kids = (el, name) => (el ? [...el.children].filter((c) => c.tagName === name) : []);
const kid = (el, name) => kids(el, name)[0];

/** Parse a GDTF (zip bytes, or the description.xml text) into a profile. */
export function readGdtf(input, fileName = 'fixture.gdtf') {
  let xml = input;
  if (typeof input !== 'string') {
    const zip = unzipSync(input instanceof Uint8Array ? input : new Uint8Array(input));
    const desc = Object.keys(zip).find((n) => /(^|\/)description\.xml$/i.test(n));
    if (!desc) throw new Error(`${fileName}: no description.xml`);
    xml = new TextDecoder().decode(zip[desc]);
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const ft = doc.getElementsByTagName('FixtureType')[0];
  if (!ft) throw new Error(`${fileName}: not a GDTF file`);

  // Wheels: slot colours (for colour wheels) and names (for gobos).
  const wheels = {};
  for (const w of doc.getElementsByTagName('Wheel')) {
    wheels[w.getAttribute('Name')] = kids(w, 'Slot').map((s) => ({ name: s.getAttribute('Name') || '', color: xyYtoRGB(s.getAttribute('Color')) }));
  }
  const beams = [...doc.getElementsByTagName('Beam')];
  const beamAngle = Number(beams[0]?.getAttribute('BeamAngle')) || 0;

  // Geometry references (multi-cell fixtures): template geometry name → [{ name, offset }].
  const refs = {};
  for (const g of doc.getElementsByTagName('GeometryReference')) {
    const tmpl = g.getAttribute('Geometry');
    const brk = kid(g, 'Break');
    (refs[tmpl] ||= []).push({ name: g.getAttribute('Name'), offset: Number(brk?.getAttribute('DMXOffset') || 1) - 1 });
  }

  let panRange = 540, tiltRange = 270, tiltCenter = 0, allDimmerN = true, anyChannel = false;
  const personalities = kids(kid(ft, 'DMXModes'), 'DMXMode').map((mode, pi) => {
    const chans = [];
    const segOf = new Map();
    const addChannel = (dc, extraOffset, geomName) => {
      const offs = String(dc.getAttribute('Offset') || '').split(',').filter(Boolean).map(Number);
      if (!offs.length) return; // virtual channel
      if (Number(dc.getAttribute('DMXBreak') || 1) !== 1) return; // only the fixture's first DMX break
      const lc = kid(dc, 'LogicalChannel');
      const name = lc?.getAttribute('Attribute') || '';
      anyChannel = true;
      if (!/^Dimmer\d+$/.test(name)) allDimmerN = false;
      const attr = attrOf(name);
      const fns = kids(lc, 'ChannelFunction');
      const geom = geomName || dc.getAttribute('Geometry') || '';
      const base = { attr, name, geom, segment: null, settings: [{ from: 0, to: 255 }] };
      const f0 = fns[0];
      // Physical ranges in degrees. Files that leave them at GDTF's default 0–1 keep the usual 540° / 270°.
      if (attr === 'pan' && f0) { const r = Math.abs(Number(f0.getAttribute('PhysicalTo')) - Number(f0.getAttribute('PhysicalFrom'))); if (r > 10) panRange = r; }
      if (attr === 'tilt' && f0) {
        const a = Number(f0.getAttribute('PhysicalFrom')), b = Number(f0.getAttribute('PhysicalTo'));
        if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) > 10) { tiltRange = Math.abs(b - a); tiltCenter = (a + b) / 2; }
      }
      if (attr === 'zoom' && f0) {
        base.minAngle = Number(f0.getAttribute('PhysicalFrom')) || undefined;
        base.maxAngle = Number(f0.getAttribute('PhysicalTo')) || undefined;
        base.settings = [{ from: dmx8(f0.getAttribute('DMXFrom')), to: 255 }];
      }
      // Ranges for shutter / wheels: from channel functions, split by channel sets where they exist.
      if (attr === 'strobe' || attr === 'colorWheel' || attr === 'gobo') {
        const ranges = [];
        fns.forEach((fn, k) => {
          const from = dmx8(fn.getAttribute('DMXFrom'));
          const to = k + 1 < fns.length ? dmx8(fns[k + 1].getAttribute('DMXFrom')) - 1 : 255;
          const fa = fn.getAttribute('Attribute') || '', fname = `${fn.getAttribute('Name') || ''}`;
          const sets = kids(fn, 'ChannelSet');
          const pieces = sets.length ? sets.map((cs, j) => ({
            from: dmx8(cs.getAttribute('DMXFrom')),
            to: j + 1 < sets.length ? dmx8(sets[j + 1].getAttribute('DMXFrom')) - 1 : to,
            label: cs.getAttribute('Name') || fname, slot: Number(cs.getAttribute('WheelSlotIndex') || 0),
          })) : [{ from, to, label: fname, slot: 0 }];
          for (const p of pieces) {
            if (attr === 'strobe') {
              let kind = 'open';
              if (/Strobe(Random|Pulse)?/.test(fa) || /strobe/i.test(p.label)) kind = /Random/i.test(fa + p.label) ? 'random' : /Pulse/i.test(fa + p.label) ? 'pulse' : 'strobe';
              else if (/clos/i.test(p.label)) kind = 'closed';
              ranges.push({ from: p.from, to: p.to, kind, reverse: false });
            } else {
              const slots = wheels[fn.getAttribute('Wheel')] || [];
              const slot = slots[(p.slot || 1) - 1];
              ranges.push(attr === 'colorWheel'
                ? { from: p.from, to: p.to, color: slot?.color || null }
                : { from: p.from, to: p.to, id: slot?.name || p.label, shake: /shake/i.test(p.label) });
            }
          }
        });
        base.ranges = ranges.filter((r) => r.to >= r.from);
      }
      const shift = extraOffset;
      if (offs.length > 1) {
        chans.push({ index: offs[0] - 1 + shift, ...base });
        chans.push({ index: offs[1] - 1 + shift, attr: `${attr}Fine`, name: `${name} fine`, geom, segment: null, settings: [] });
      } else chans.push({ index: offs[0] - 1 + shift, ...base });
    };
    for (const dc of kids(kid(mode, 'DMXChannels'), 'DMXChannel')) {
      const g = dc.getAttribute('Geometry');
      if (refs[g]) refs[g].forEach((r) => addChannel(dc, r.offset, r.name));
      else addChannel(dc, 0, null);
    }
    // Multi-cell fixtures: a colour attribute that appears on more than one geometry means one cell per geometry.
    const CELL = ['red', 'green', 'blue', 'white', 'warmWhite', 'amber', 'uv', 'cyan', 'magenta', 'yellow'];
    if (CELL.some((a) => new Set(chans.filter((c) => c.attr === a).map((c) => c.geom)).size > 1)) {
      for (const c of chans) if (CELL.includes(c.attr) && !segOf.has(c.geom)) segOf.set(c.geom, segOf.size);
      for (const c of chans) if (segOf.has(c.geom)) c.segment = segOf.get(c.geom);
    }
    const footprint = chans.reduce((m, c) => Math.max(m, c.index + 1), 0);
    const channels = Array.from({ length: footprint }, (_, i) => ({ index: i, attr: 'raw', name: `Ch ${i + 1}`, settings: [] }));
    for (const c of chans) channels[c.index] = c;
    let gobos = 0, cw = 0;
    for (const c of channels) {
      if (c.attr === 'gobo') c.wheel = gobos++;
      if (c.attr === 'colorWheel') c.wheel = cw++;
    }
    const attrs = new Set(channels.map((c) => c.attr));
    return {
      index: pi, name: mode.getAttribute('Name') || `${footprint}ch`, footprint, channels,
      segments: Math.max(1, segOf.size), has: attrs,
      hasColor: ['red', 'green', 'blue', 'cyan'].some((a) => attrs.has(a)),
      hasPanTilt: attrs.has('pan') || attrs.has('tilt'),
      zoom: channels.find((c) => c.attr === 'zoom' && c.minAngle != null),
    };
  });

  const mover = personalities.some((p) => p.hasPanTilt);
  return {
    uuid: ft.getAttribute('FixtureTypeID') || fileName,
    name: ft.getAttribute('Name') || ft.getAttribute('LongName') || fileName.replace(/\.gdtf$/i, ''),
    manufacturer: ft.getAttribute('Manufacturer') || '',
    kind: mover ? 'mover' : personalities.some((p) => p.hasColor) ? 'color' : 'other',
    panRange, tiltRange, tiltCenter, beamSpread: beamAngle, beamAngle,
    personalities,
    source: 'gdtf', fileName,
    placeholder: anyChannel && allDimmerN,
  };
}
