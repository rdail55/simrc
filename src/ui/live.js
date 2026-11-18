// Live pages: Lightkey's Live view rebuilt from the project. Buttons, faders, frames and cuelists sit where they
// do in Lightkey. As in Lightkey, only the visible page drives the lights (switching pages releases its cues and
// brings back what was running on the page you return to), and buttons whose edges touch form an exclusive
// group: firing one releases the others.

const BUTTON_COLORS = {
  red: '#c8453c', orange: '#d27a2c', yellow: '#c9a227', green: '#3f9a4b', mint: '#3aa89a', teal: '#2f8f9f', cyan: '#3596c4',
  blue: '#3a6fd0', indigo: '#5a52c7', purple: '#8e4fc0', pink: '#c24f86', brown: '#8d6a4b', gray: '#6b6f78', grey: '#6b6f78',
};
const colorOf = (name) => {
  if (!name) return null;
  const k = String(name).toLowerCase().replace(/^system/, '').replace(/color$/, '');
  return BUTTON_COLORS[k] || null;
};

/** Buttons whose rectangles share an edge (Lightkey "attached" buttons) → arrays of exclusive groups. */
function attachedGroups(buttons) {
  const parent = buttons.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a, b) => {
    const E = 2;
    const overlapY = a.y < b.y + b.h - E && b.y < a.y + a.h - E;
    const overlapX = a.x < b.x + b.w - E && b.x < a.x + a.w - E;
    return (overlapY && (Math.abs(a.x + a.w - b.x) <= E || Math.abs(b.x + b.w - a.x) <= E))
      || (overlapX && (Math.abs(a.y + a.h - b.y) <= E || Math.abs(b.y + b.h - a.y) <= E));
  };
  for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
    if (buttons[i].rect && buttons[j].rect && touch(buttons[i].rect, buttons[j].rect)) parent[find(i)] = find(j);
  }
  const groups = new Map();
  buttons.forEach((b, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(b); });
  return [...groups.values()].filter((g) => g.length > 1);
}

export class LivePanel {
  constructor(container, engine, { onCueSelect, onRemove } = {}) {
    this.container = container;
    this.engine = engine;
    this.onCueSelect = onCueSelect;
    this.onRemove = onRemove;
    this.pageIndex = 0;
    this.memory = new Map(); // page uuid → Set of cues that were running when you left it
    this.cuelistPos = new Map(); // cuelist item → index
    this.els = new Map(); // item → element
    this.frameStep = new Map();
  }

  get page() { return this.engine.project.pages[this.pageIndex]; }

  ctxFor(item) {
    return {
      pagePriority: this.page.priority, framePriority: item.frame?.priority ?? item.priority ?? 5,
      frameSpeed: item.frame?.speed ?? 1,
    };
  }

  showPage(i) {
    const old = this.page;
    if (old && i !== this.pageIndex) {
      const running = new Set();
      for (const it of old.items) {
        if ((it.kind === 'button' || it.kind === 'fader') && this.engine.isCueActive(it.cue)) running.add(it);
        if (it.kind === 'cuelist') for (const c of it.cues) if (this.engine.isCueActive(c.cue)) running.add({ ...it, cue: c.cue });
      }
      this.memory.set(old.uuid, running);
      for (const it of running) this.engine.releaseCue(it.cue, old.fade);
    }
    this.pageIndex = i;
    for (const it of this.memory.get(this.page.uuid) || []) this.engine.activateCue(it.cue, { ...this.ctxFor(it), fadeIn: this.page.fade });
    this.render();
  }

  fire(item, on = !this.engine.isCueActive(item.cue)) {
    if (on) {
      for (const other of this.groupOf.get(item) || []) if (other !== item) this.engine.releaseCue(other.cue, item.cue.fadeIn);
      this.engine.activateCue(item.cue, this.ctxFor(item));
    } else {
      this.engine.releaseCue(item.cue);
    }
    this.onCueSelect?.(item.cue);
  }

  step(frame, dir) {
    const list = frame.buttons.filter((b) => b.kind === 'button');
    if (!list.length) return;
    let i = list.findIndex((b) => this.engine.isCueActive(b.cue));
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    for (const b of list) if (b !== list[i]) this.engine.releaseCue(b.cue, list[i].cue.fadeIn);
    this.engine.activateCue(list[i].cue, this.ctxFor(list[i]));
    this.onCueSelect?.(list[i].cue);
  }

  go(list, dir = 1) {
    const cues = list.cues.filter((c) => c.ticked);
    if (!cues.length) return;
    let i = this.cuelistPos.has(list) ? this.cuelistPos.get(list) + dir : dir > 0 ? 0 : cues.length - 1;
    if (i >= cues.length) i = list.loops ? 0 : cues.length - 1;
    if (i < 0) i = 0;
    const next = cues[i];
    for (const c of list.cues) if (c !== next) this.engine.releaseCue(c.cue, next.cue.fadeIn);
    this.engine.activateCue(next.cue, { pagePriority: this.page.priority, framePriority: list.priority });
    this.cuelistPos.set(list, i);
    this.onCueSelect?.(next.cue);
    this.render();
  }

  stopList(list) {
    for (const c of list.cues) this.engine.releaseCue(c.cue);
    this.cuelistPos.delete(list);
    this.render();
  }

  render() {
    const page = this.page;
    const c = this.container;
    c.innerHTML = '';
    this.els.clear();
    if (!page) { c.innerHTML = '<div class="empty">This project has no Live pages.</div>'; return; }
    const surface = document.createElement('div');
    surface.className = 'live-surface';
    let maxX = 0, maxY = 0;
    const grow = (r) => { if (r) { maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h); } };

    const buttons = page.items.filter((it) => it.kind === 'button');
    this.groupOf = new Map();
    for (const g of attachedGroups(buttons)) for (const b of g) this.groupOf.set(b, g);

    // Frames first so they sit underneath their buttons.
    const order = [...page.items].sort((a, b) => (a.kind === 'frame' ? -1 : 0) - (b.kind === 'frame' ? -1 : 0));
    for (const it of order) {
      if (!it.rect) continue;
      grow(it.rect);
      const el = document.createElement('div');
      Object.assign(el.style, { left: `${it.rect.x}px`, top: `${it.rect.y}px`, width: `${it.rect.w}px`, height: `${it.rect.h}px` });
      if (it.kind === 'frame') {
        el.className = 'lk-frame';
        el.innerHTML = `<div class="lk-frame-title"></div>`;
        el.firstChild.textContent = it.name;
        if (it.steps) {
          const nav = document.createElement('div');
          nav.className = 'lk-frame-nav';
          nav.innerHTML = '<button title="Previous cue">◀</button><button title="Next cue">▶</button>';
          nav.children[0].onclick = () => this.step(it, -1);
          nav.children[1].onclick = () => this.step(it, 1);
          el.appendChild(nav);
        }
      } else if (it.kind === 'button') {
        el.className = 'lk-button' + (this.groupOf.has(it) ? ' attached' : '') + (it.flash ? ' flash' : '');
        const col = colorOf(it.color);
        if (col) el.style.setProperty('--btn', col);
        el.innerHTML = '<span class="lvl"></span><span class="name"></span>';
        el.querySelector('.name').textContent = it.cue.name;
        el.title = `${it.cue.name}\nFade in ${it.cue.fadeIn}s · out ${it.cue.fadeOut}s · priority ${it.cue.priority}${it.flash ? ' · flash' : ''}`;
        if (it.flash) {
          el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); this.fire(it, true); });
          el.addEventListener('pointerup', () => this.fire(it, false));
        } else el.addEventListener('click', () => this.fire(it));
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onRemove?.(it); });
      } else if (it.kind === 'fader') {
        el.className = 'lk-fader' + (it.vertical ? ' vertical' : '');
        el.innerHTML = '<input type="range" min="0" max="1" step="0.005" value="0"><span class="name"></span>';
        el.querySelector('.name').textContent = it.cue.name;
        const input = el.querySelector('input');
        input.value = this.engine.isCueActive(it.cue) ? this.engine.layers.get(`cue:${it.cue.uuid}`)?.scale ?? 0 : 0;
        input.addEventListener('input', () => this.engine.setCueLevel(it.cue, Number(input.value), this.ctxFor(it)));
      } else if (it.kind === 'cuelist') {
        el.className = 'lk-cuelist';
        const pos = this.cuelistPos.get(it);
        el.innerHTML = `<div class="cl-head"><button class="go" title="Next cue (Space)">GO</button><button class="back" title="Previous cue (Shift+Space)">Back</button><button class="stop">Stop</button><b></b></div><ol></ol>`;
        el.querySelector('b').textContent = it.name;
        el.querySelector('.go').onclick = () => this.go(it, 1);
        el.querySelector('.back').onclick = () => this.go(it, -1);
        el.querySelector('.stop').onclick = () => this.stopList(it);
        const ol = el.querySelector('ol');
        const ticked = it.cues.filter((x) => x.ticked);
        it.cues.forEach((cn) => {
          const li = document.createElement('li');
          li.textContent = cn.name;
          if (!cn.ticked) li.classList.add('off');
          if (pos != null && ticked[pos] === cn) li.classList.add('current');
          li.ondblclick = () => { this.cuelistPos.set(it, ticked.indexOf(cn) - 1); this.go(it, 1); };
          ol.appendChild(li);
        });
      } else {
        el.className = 'lk-label';
        el.textContent = it.text || '';
      }
      surface.appendChild(el);
      this.els.set(it, el);
    }
    surface.style.width = `${maxX + 12}px`;
    surface.style.height = `${maxY + 12}px`;
    c.appendChild(surface);
    this.refresh();
  }

  /** Update active highlights and fade levels (called every frame). */
  refresh() {
    for (const [it, el] of this.els) {
      if (it.kind === 'button') {
        const active = this.engine.isCueActive(it.cue);
        el.classList.toggle('active', active);
        el.querySelector('.lvl').style.width = `${Math.round(this.engine.cueLevel(it.cue) * 100)}%`;
      } else if (it.kind === 'fader') {
        el.classList.toggle('active', this.engine.isCueActive(it.cue));
      } else if (it.kind === 'cuelist') {
        const lis = el.querySelectorAll('li');
        it.cues.forEach((cn, i) => lis[i]?.classList.toggle('running', this.engine.isCueActive(cn.cue)));
      }
    }
  }
}
