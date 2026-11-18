// Live inputs from the DMX/NDI bridge (Arena Practice/rig-sim-bridge.py, http://localhost:8770): Art-Net and sACN
// universes over server-sent events, NDI frames over long-polling. Universes here use the Capture/Lightkey numbering:
// Universe N = Art-Net port-address N-1 = sACN universe N.
export class Bridge {
  constructor(url = 'http://localhost:8770') {
    this.url = url;
    this.unis = new Map();   // universe (1-based) → Uint8Array(512)
    this.stats = {};         // universe → { proto, srcs[], age, raw }
    this.ok = false;
    this.lastFrame = 0;
    this.ndi = { available: false, sources: [], selected: null, connected: null, fps: 0 };
    this.frame = null;       // latest NDI frame { data, w, h, seq }
    this.connect();
    this.pollSources();
  }

  connect() {
    this.es?.close();
    const es = (this.es = new EventSource(`${this.url}/events`));
    es.onopen = () => { this.ok = true; };
    es.onerror = () => { this.ok = false; };
    es.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const stats = {};
      for (const [k, st] of Object.entries(m.s)) {
        const u = st.proto === 'sACN' ? Number(k) : Number(k) + 1;
        stats[u] = { ...st, raw: Number(k) };
      }
      for (const [k, b64] of Object.entries(m.u)) {
        const st = m.s[k];
        const u = st?.proto === 'sACN' ? Number(k) : Number(k) + 1;
        const bin = atob(b64);
        const a = this.unis.get(u) || new Uint8Array(512);
        for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        this.unis.set(u, a);
      }
      this.stats = stats;
      this.lastFrame = performance.now();
    };
  }

  /** Byte at 1-based universe `u`, 0-based channel `ch` (may run past 511 into the next universes). */
  get(u, ch) {
    const uu = u + Math.floor(ch / 512);
    return this.unis.get(uu)?.[ch % 512] ?? 0;
  }

  async pollSources() {
    try {
      const r = await fetch(`${this.url}/ndi/sources`);
      this.ndi = await r.json();
    } catch { this.ndi = { ...this.ndi, available: false }; }
    setTimeout(() => this.pollSources(), 2000);
  }

  async selectNdi(name, hq = false) {
    try {
      const r = await fetch(`${this.url}/ndi/select?name=${encodeURIComponent(name || '')}&hq=${hq ? 1 : 0}`);
      this.ndi = await r.json();
    } catch { /* bridge not running */ }
    if (name && !this.ndiLoop) this.runNdi();
  }

  async runNdi() {
    this.ndiLoop = true;
    let seq = -1;
    while (this.ndi.selected) {
      try {
        const r = await fetch(`${this.url}/ndi/frame?after=${seq}`);
        if (r.status === 200) {
          seq = Number(r.headers.get('X-Seq'));
          const data = new Uint8Array(await r.arrayBuffer()), w = Number(r.headers.get('X-W')), h = Number(r.headers.get('X-H'));
          if (w && h && data.length === w * h * 4) this.frame = { data, w, h, seq };
        } else if (r.status !== 204) await new Promise((res) => setTimeout(res, 2000));
      } catch { await new Promise((res) => setTimeout(res, 2000)); }
    }
    this.ndiLoop = false;
  }
}
