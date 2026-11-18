// PixelStix on the back wall: 1×40 RGB pixels per stick (120 channels), placed from a Stix Arranger layout
// (Arena Practice: x/y in feet from the left wall edge / above the deck, angle in degrees, pixel 1 at x − dx).
// The layout is anchored to the projector screen, which is how it was drawn: the screen's centre and bottom edge
// in the layout (from the stage photo) are matched to the screen in the MVR.
import * as THREE from 'three';

export const PIXELS = 40;
const FT = 304.8; // mm
// Where the screen sits in Arranger layout coordinates (Arena Practice rig-sim.html, from the stage photo).
const LAYOUT_SCREEN = { cx: 18.78, bottom: 6.62 };

/** Sticks in Arena slice order: left → right, then top first in each column. */
export function orderSticks(layout) {
  const len = layout.stickLen || 3.25;
  const list = (layout.sticks || []).map((s) => {
    const r = (s.a * Math.PI) / 180, dx = (Math.cos(r) * len) / 2, dy = (Math.sin(r) * len) / 2;
    return { s, x1: s.x - dx, y1: s.y - dy, x2: s.x + dx, y2: s.y + dy };
  });
  list.sort((a, b) => (Math.round(a.s.x * 4) - Math.round(b.s.x * 4)) || (b.s.y - a.s.y));
  return list;
}

/** 0-based universe offset and 1-based start channel of stick i: 4 per universe at 1, 121, 241, 361. */
export const stickPatch = (i) => ({ uniOffset: Math.floor(i / 4), address: (i % 4) * 120 + 1 });

export class Stix {
  constructor(world) {
    this.world = world;
    this.group = new THREE.Group();
    world.add(this.group);
    this.sticks = [];
  }

  /** opts: { layout, screen: { cx, bottom, face } (MVR mm), depth (mm in front of the screen face) } */
  build({ layout, screen, depth = 150 }) {
    for (const c of [...this.group.children]) { this.group.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    this.pixels = this.glow = null;
    if (this.group.parent !== this.world) this.world.add(this.group); // the stage clears the world on rebuild
    this.sticks = orderSticks(layout);
    const n = this.sticks.length * PIXELS;
    if (!n) return;
    const toMvr = (x, y) => [(x - LAYOUT_SCREEN.cx) * FT + screen.cx, screen.face - depth, (y - LAYOUT_SCREEN.bottom) * FT + screen.bottom];
    const pixelGeo = new THREE.BoxGeometry(20, 20, 20);
    const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2); // faces −Y (the audience)
    this.pixels = new THREE.InstancedMesh(pixelGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), n);
    this.glow = new THREE.InstancedMesh(glowGeo, new THREE.MeshBasicMaterial({
      map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    }), n);
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 30, 30), new THREE.MeshLambertMaterial({ color: 0x1a1b1e }), this.sticks.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    this.sticks.forEach((st, i) => {
      const a = toMvr(st.x1, st.y1), b = toMvr(st.x2, st.y2);
      const mid = a.map((v, k) => (v + b[k]) / 2);
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      e.set(0, -Math.atan2(b[2] - a[2], b[0] - a[0]), 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(mid[0], mid[1] + 25, mid[2]), q, new THREE.Vector3(len, 1, 1));
      bars.setMatrixAt(i, m);
      st.pos = [];
      for (let k = 0; k < PIXELS; k++) {
        const t = (k + 0.5) / PIXELS;
        const p = a.map((v, j) => v + (b[j] - v) * t);
        st.pos.push(p);
        m.makeTranslation(p[0], p[1], p[2]);
        this.pixels.setMatrixAt(i * PIXELS + k, m);
        m.compose(new THREE.Vector3(p[0], p[1] - 20, p[2]), new THREE.Quaternion(), new THREE.Vector3(170, 1, 170));
        this.glow.setMatrixAt(i * PIXELS + k, m);
      }
    });
    this.color = new THREE.Color();
    for (let i = 0; i < n; i++) { this.pixels.setColorAt(i, this.color.setRGB(0, 0, 0)); this.glow.setColorAt(i, this.color); }
    this.group.add(bars, this.pixels, this.glow);
  }

  /** rgbAt(stickIndex, pixel) → [r, g, b] bytes */
  update(rgbAt, glow = 1) {
    if (!this.pixels) return;
    const c = this.color;
    this.sticks.forEach((_, i) => {
      for (let k = 0; k < PIXELS; k++) {
        const [r, g, b] = rgbAt(i, k);
        c.setRGB(r / 255, g / 255, b / 255);
        this.pixels.setColorAt(i * PIXELS + k, c);
        c.multiplyScalar(glow);
        this.glow.setColorAt(i * PIXELS + k, c);
      }
    });
    this.pixels.instanceColor.needsUpdate = true;
    this.glow.instanceColor.needsUpdate = true;
  }
}

function glowTexture() {
  const s = 64, cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}
