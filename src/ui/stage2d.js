// 2D stage preview, drawn like Lightkey's Preview: the stage drawing from the project, and each fixture as a
// lamp coloured by its live output (one wedge per cell for multi-cell fixtures). Click a fixture to inspect it.
import { segmentLook } from '../engine.js';

const css = (rgb, a = 1) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;

export class Stage2D {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.project = null;
    this.states = null;
    this.selected = null;
    this.onSelect = onSelect;
    this.active = true;
    this.showLabels = true;
    new ResizeObserver(() => this.resize()).observe(container);
    this.canvas.addEventListener('click', (e) => this.pick(e));
    this.resize();
  }

  setProject(project) {
    this.project = project;
    this.selected = null;
    this.fit();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.dpr = dpr;
    this.fit();
  }

  /** Fit the drawing and fixtures into the canvas. */
  fit() {
    const p = this.project;
    if (!p) return;
    const pts = [];
    for (const f of p.fixtures) if (f.stage) pts.push([f.stage.x - 8, f.stage.y - 8], [f.stage.x + 8, f.stage.y + 8]);
    for (const s of p.stage.shapes) {
      pts.push([s.center[0] - s.size[0] / 2, s.center[1] - s.size[1] / 2], [s.center[0] + s.size[0] / 2, s.center[1] + s.size[1] / 2]);
      for (const k of s.knots || []) pts.push(k);
    }
    if (!pts.length) pts.push([-100, -60], [100, 60]);
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const W = this.canvas.width, H = this.canvas.height, pad = 30 * this.dpr;
    this.scale = Math.min((W - 2 * pad) / Math.max(1, maxX - minX), (H - 2 * pad) / Math.max(1, maxY - minY));
    this.ox = W / 2 - ((minX + maxX) / 2) * this.scale;
    this.oy = H / 2 + ((minY + maxY) / 2) * this.scale;
  }

  toScreen(x, y) { return [this.ox + x * this.scale, this.oy - y * this.scale]; }

  /** Fixtures without a stage position get a row along the bottom so they're still visible. */
  positionOf(f) {
    if (f.stage) return this.toScreen(f.stage.x, f.stage.y);
    const loose = this.project.fixtures.filter((x) => !x.stage);
    const i = loose.indexOf(f);
    const W = this.canvas.width, step = Math.min(40 * this.dpr, (W - 40 * this.dpr) / Math.max(1, loose.length));
    return [20 * this.dpr + step * (i + 0.5), this.canvas.height - 20 * this.dpr];
  }

  pick(e) {
    if (!this.project) return;
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) * this.dpr, y = (e.clientY - r.top) * this.dpr;
    let best = null, bestD = 18 * this.dpr;
    for (const f of this.project.fixtures) {
      const [fx, fy] = this.positionOf(f);
      const d = Math.hypot(fx - x, fy - y);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!this.selection) this.selected = best;
    this.onSelect?.(best, e);
  }

  drawShape(s) {
    const { ctx } = this;
    const [cx, cy] = this.toScreen(s.center[0], s.center[1]);
    const w = s.size[0] * this.scale, h = s.size[1] * this.scale;
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.lineWidth = Math.max(1, s.strokeWidth * this.scale * 0.25);
    const stroke = s.stroke ? css(s.stroke, s.strokeOpacity) : 'rgba(150,150,150,.5)';
    const fill = s.fill ? css(s.fill, s.fillOpacity) : 'transparent';
    if (s.kind === 'spline' && s.knots?.length > 1) {
      ctx.beginPath();
      s.knots.forEach((k, i) => { const [x, y] = this.toScreen(k[0], k[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = stroke;
      ctx.lineCap = 'round';
      ctx.stroke();
    } else if (s.kind === 'text') {
      ctx.translate(cx, cy);
      ctx.rotate(-s.angle);
      ctx.fillStyle = 'rgba(200,205,215,.75)';
      const lines = String(s.text || '').split('\n');
      const longest = Math.max(1, ...lines.map((l) => l.length));
      const px = Math.max(8 * this.dpr, Math.min(h / lines.length * 0.9, (w / longest) * 1.9));
      ctx.font = `${px}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * px * 1.15));
    } else {
      ctx.translate(cx, cy);
      ctx.rotate(-s.angle);
      ctx.beginPath();
      if (s.kind === 'oval') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = fill;
      ctx.fill();
      if (s.strokeOpacity > 0) { ctx.strokeStyle = stroke; ctx.stroke(); }
    }
    ctx.restore();
  }

  draw() {
    const { ctx, project: p } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = '#121316';
    ctx.fillRect(0, 0, W, H);
    if (!p) return;
    for (const s of p.stage.shapes) this.drawShape(s);

    const now = performance.now();
    const r0 = Math.max(6 * this.dpr, Math.min(14 * this.dpr, 4.5 * this.scale));
    // Glows first (additive), then lamp bodies.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of p.fixtures) {
      const st = this.states?.[f.index];
      if (!st) continue;
      const [x, y] = this.positionOf(f);
      for (const s of st.seg) {
        const { rgb, b } = segmentLook(f, s, st, now);
        if (b < 0.02) continue;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r0 * 3.2);
        g.addColorStop(0, css(rgb, 0.55 * b / st.seg.length));
        g.addColorStop(1, css(rgb, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r0 * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    ctx.font = `${10 * this.dpr}px -apple-system, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of p.fixtures) {
      const st = this.states?.[f.index];
      const [x, y] = this.positionOf(f);
      const n = st?.seg.length || 1;
      for (let i = 0; i < n; i++) {
        const look = st ? segmentLook(f, st.seg[i], st, now) : { rgb: [0, 0, 0], b: 0 };
        ctx.beginPath();
        if (n === 1) ctx.arc(x, y, r0, 0, Math.PI * 2);
        else { ctx.moveTo(x, y); ctx.arc(x, y, r0, -Math.PI / 2 + (i * 2 * Math.PI) / n, -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / n); ctx.closePath(); }
        const k = look.b;
        ctx.fillStyle = css([0.1 + look.rgb[0] * k * 0.9, 0.1 + look.rgb[1] * k * 0.9, 0.11 + look.rgb[2] * k * 0.9]);
        ctx.fill();
      }
      const picked = f === this.selected || this.selection?.has(f.uuid);
      ctx.lineWidth = (picked ? 2.5 : 1) * this.dpr;
      ctx.strokeStyle = picked ? '#4f9dff' : f.per?.hasPanTilt ? '#8a8f99' : '#4a4e56';
      ctx.beginPath();
      if (f.per?.hasPanTilt) ctx.rect(x - r0, y - r0, r0 * 2, r0 * 2);
      else ctx.arc(x, y, r0, 0, Math.PI * 2);
      ctx.stroke();
      // Pan/tilt pointer for movers.
      if (f.per?.hasPanTilt && st) {
        const len = r0 * 1.6 * Math.min(1, Math.abs(Math.sin(st.tilt)) + 0.15);
        const a = -Math.PI / 2 + (f.stage?.panInverted ? -st.pan : st.pan);
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.lineWidth = 1.2 * this.dpr;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len * Math.sign(st.tilt || 1), y + Math.sin(a) * len * Math.sign(st.tilt || 1));
        ctx.stroke();
      }
      if (this.showLabels) {
        ctx.fillStyle = 'rgba(190,195,205,.8)';
        ctx.fillText(f.name, x, y + r0 + 3 * this.dpr);
      }
    }
  }

  render() {
    if (this.active) this.draw();
  }
}
