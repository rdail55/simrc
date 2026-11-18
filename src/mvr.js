// MVR (My Virtual Rig) reader, in the browser. An .mvr is a zip holding GeneralSceneDescription.xml (a tree of
// objects with 4x3 matrices, millimetres, Z up), 3DS meshes, and GDTF fixture files. We flatten it into unique
// meshes + instance matrices, and fixtures with world matrices and DMX addresses. Ported from Custom DMX.
import { unzipSync } from 'fflate';

const IDENTITY = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

function parseMatrix(s) {
  if (!s) return IDENTITY;
  const g = String(s).match(/\{[^}]*\}/g)?.map((x) => x.slice(1, -1).split(',').map(Number));
  if (!g || g.length < 4) return IDENTITY;
  return { r: [...g[0], ...g[1], ...g[2]], o: g[3] };
}

function apply(m, p) {
  const [ux, uy, uz, vx, vy, vz, wx, wy, wz] = m.r;
  return [ux * p[0] + vx * p[1] + wx * p[2], uy * p[0] + vy * p[1] + wy * p[2], uz * p[0] + vz * p[1] + wz * p[2]];
}

function compose(a, b) {
  const u = apply(a, b.r.slice(0, 3)), v = apply(a, b.r.slice(3, 6)), w = apply(a, b.r.slice(6, 9));
  const o = apply(a, b.o).map((x, i) => x + a.o[i]);
  return { r: [...u, ...v, ...w], o };
}

const flat = (m) => [...m.r, ...m.o];

function parse3ds(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const positions = [], indices = [];
  let base = 0;
  function walk(off, end) {
    while (off + 6 <= end) {
      const id = dv.getUint16(off, true), len = dv.getUint32(off + 2, true);
      if (len < 6 || off + len > end) break;
      const body = off + 6;
      if (id === 0x4d4d || id === 0x3d3d) walk(body, off + len);
      else if (id === 0x4000) { let p = body; while (p < off + len && buf[p] !== 0) p++; walk(p + 1, off + len); }
      else if (id === 0x4100) { base = positions.length / 3; walk(body, off + len); }
      else if (id === 0x4110) {
        const n = dv.getUint16(body, true);
        for (let i = 0; i < n * 3; i++) positions.push(dv.getFloat32(body + 2 + i * 4, true));
      } else if (id === 0x4120) {
        const n = dv.getUint16(body, true);
        for (let i = 0; i < n; i++) {
          const q = body + 2 + i * 8;
          indices.push(base + dv.getUint16(q, true), base + dv.getUint16(q + 2, true), base + dv.getUint16(q + 4, true));
        }
      }
      off += len;
    }
  }
  walk(0, buf.length);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const NODE_TYPES = new Set(['SceneObject', 'GroupObject', 'Fixture', 'Truss', 'Support', 'VideoScreen', 'Projector', 'FocusPoint']);
const kids = (el, name) => [...el.children].filter((c) => c.tagName === name);
const kid = (el, name) => kids(el, name)[0];
const text = (el, name) => kid(el, name)?.textContent?.trim() || '';

export function readMvr(bytes, fileName = 'scene.mvr') {
  const zip = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const xmlName = Object.keys(zip).find((n) => /GeneralSceneDescription\.xml$/i.test(n));
  if (!xmlName) throw new Error('Not an MVR file (no GeneralSceneDescription.xml)');
  const xml = new TextDecoder().decode(zip[xmlName]);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const generator = (xml.match(/<!--\s*Created by ([^-]+?)\s*-->/) || [])[1] || doc.documentElement.getAttribute('ProviderVersion') || null;

  const meshIndex = new Map();
  const meshes = [], instances = [], fixtures = [];

  function useMesh(name) {
    if (!meshIndex.has(name)) {
      const data = zip[name];
      const m = data ? parse3ds(data) : null;
      if (!m || !m.indices.length) { meshIndex.set(name, -1); return -1; }
      meshIndex.set(name, meshes.length);
      meshes.push({ file: name, ...m, triangles: m.indices.length / 3 });
    }
    return meshIndex.get(name);
  }

  function visit(node, parent) {
    const world = compose(parent, parseMatrix(text(node, 'Matrix')));
    if (node.tagName === 'Fixture') {
      const addrEl = kid(kid(node, 'Addresses') || node, 'Address');
      const address = Number(addrEl?.textContent || 0);
      const brk = Number(addrEl?.getAttribute('break') || 0);
      fixtures.push({
        name: node.getAttribute('name') || '', gdtf: text(node, 'GDTFSpec'), mode: text(node, 'GDTFMode'),
        fixtureId: text(node, 'FixtureID'),
        universe: address > 512 ? Math.floor((address - 1) / 512) : brk,
        address: address > 512 ? ((address - 1) % 512) + 1 : address,
        matrix: flat(world),
      });
    }
    for (const g of kids(kid(node, 'Geometries') || node, 'Geometry3D')) {
      const id = useMesh(g.getAttribute('fileName'));
      if (id >= 0) instances.push([id, ...flat(compose(world, parseMatrix(text(g, 'Matrix'))))]);
    }
    const list = kid(node, 'ChildList');
    if (list) for (const c of list.children) if (NODE_TYPES.has(c.tagName)) visit(c, world);
  }

  for (const layer of doc.getElementsByTagName('Layer')) {
    const lm = parseMatrix(text(layer, 'Matrix'));
    const list = kid(layer, 'ChildList');
    if (list) for (const c of list.children) if (NODE_TYPES.has(c.tagName)) visit(c, lm);
  }

  // Beam angle from each GDTF (itself a zip): the first <Beam … BeamAngle="…">.
  const beamAngles = {};
  for (const name of Object.keys(zip).filter((n) => /\.gdtf$/i.test(n))) {
    try {
      const inner = unzipSync(zip[name]);
      const desc = Object.keys(inner).find((n) => /description\.xml$/i.test(n));
      const m = /<Beam\b[^>]*\bBeamAngle="([\d.]+)"/.exec(new TextDecoder().decode(inner[desc]));
      if (m) beamAngles[name.replace(/\.gdtf$/i, '')] = Number(m[1]);
    } catch { /* placeholder GDTFs from Capture are often empty */ }
  }
  for (const f of fixtures) {
    const a = beamAngles[f.gdtf.replace(/\.gdtf$/i, '')];
    if (a) f.beamAngle = a;
  }

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const grow = (p) => p.forEach((v, i) => { min[i] = Math.min(min[i], v); max[i] = Math.max(max[i], v); });
  for (const f of fixtures) grow(f.matrix.slice(9));
  for (const inst of instances) grow(inst.slice(10, 13));
  if (!Number.isFinite(min[0])) { min.fill(-5000); max.fill(5000); }

  return {
    fileName, generator, meshes, instances, fixtures, bounds: { min, max },
    stats: { meshes: meshes.length, instances: instances.length, fixtures: fixtures.length, triangles: instances.reduce((a, i) => a + meshes[i[0]].triangles, 0) },
  };
}

/** Pair MVR fixtures with project fixtures: universe + address first, then by name. */
export function matchFixtures(scene, project) {
  const byAddr = new Map(project.fixtures.map((f) => [`${f.universe - 1}:${f.address}`, f]));
  const byName = new Map(project.fixtures.map((f) => [f.name.toLowerCase(), f]));
  const used = new Set();
  for (const sf of scene.fixtures) {
    let fx = byAddr.get(`${sf.universe}:${sf.address}`);
    if (!fx || used.has(fx)) fx = byName.get(sf.name.toLowerCase());
    if (fx && used.has(fx)) fx = null;
    sf.fixture = fx || null;
    if (fx) used.add(fx);
  }
  const missing = project.fixtures.filter((f) => !used.has(f));
  return { matched: used.size, missing };
}
