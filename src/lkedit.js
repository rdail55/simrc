// Surgical editor for Lightkey projects, ported from Custom DMX's tools/lkproj.py.
//
// The project's NSKeyedArchiver object table is edited in place: new objects are appended and copy the exact
// shapes of objects of the same class already in this project (falling back to shapes captured from a Lightkey
// 6 project in templates.js). Everything else in the file (bindings, colour favourites, settings…) is untouched.
import { parseBplist, writeBplist, UID, Real, real } from './bplist.js';
import { CLASSES, OBJECTS } from './templates.js';

const CONTAINER = /^NS(Mutable)?(Array|Set|OrderedSet|Dictionary)$/;

function randomUUIDBytes() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}
const uuidString = (b) => {
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const newUUID = () => uuidString(randomUUIDBytes());

export class ProjectEditor {
  constructor(bytes) {
    this.root = parseBplist(bytes, { raw: true });
    if (!this.root.$objects) throw new Error('Not a Lightkey project');
    this.objs = this.root.$objects;
    this.top = this.root.$top;
    this.appVersion = this.S(this.top.appVersion) || '?';
    const major = Number(String(this.appVersion).split('.').slice(0, 2).join('.'));
    // Writing uses the 5.7+ preset store; older files can be viewed but not edited.
    this.supported = major >= 5.7;
  }

  // ---- archive primitives --------------------------------------------------------------------------------

  D(v) { return v instanceof UID ? this.objs[v.UID] : v; }
  S(v) { const o = this.D(v); return typeof o === 'string' ? o : o?.['NS.string'] ?? null; }
  cls(o) { return o && typeof o === 'object' && o.$class instanceof UID ? this.objs[o.$class.UID]?.$classname : null; }
  add(o) { this.objs.push(o); return new UID(this.objs.length - 1); }

  classUID(name) {
    const i = this.objs.findIndex((o) => o && typeof o === 'object' && o.$classname === name);
    if (i >= 0) return new UID(i);
    const chain = CLASSES[name];
    if (!chain) throw new Error(`No class definition for ${name}`);
    return this.add({ $classes: [...chain], $classname: name });
  }

  firstOf(name) { return this.objs.find((o) => this.cls(o) === name) || null; }

  uuidObj() {
    const bytes = randomUUIDBytes();
    return { uid: this.add({ $class: this.classUID('NSUUID'), 'NS.uuidbytes': bytes }), id: uuidString(bytes) };
  }

  str(s) { return this.add(String(s)); }

  container(className, items = [], map = null) {
    if (/Dictionary$/.test(className)) {
      const keys = Object.keys(map || {});
      return this.add({ 'NS.keys': keys.map((k) => this.str(k)), 'NS.objects': keys.map((k) => this.addValue(map[k])), $class: this.classUID(className) });
    }
    return this.add({ 'NS.objects': [...items], $class: this.classUID(className) });
  }

  addValue(v) {
    if (v instanceof UID) return v;
    if (typeof v === 'string') return this.str(v);
    return this.add(v); // numbers, Real, booleans are stored inline in $objects
  }

  /**
   * A new object shaped like `tmpl` (an object of the same class in this project, or a templates.js spec).
   * Containers become fresh empty containers of the same class, UUIDs are new, strings and other values are
   * kept unless overridden. Overrides may be UIDs, Reals, numbers, booleans or strings.
   */
  fresh(className, overrides = {}) {
    const own = this.firstOf(className);
    const out = { $class: this.classUID(className) };
    let uuid = null;
    if (own) {
      for (const [k, v] of Object.entries(own)) {
        if (k === '$class') continue;
        const t = v instanceof UID ? this.objs[v.UID] : null;
        const c = this.cls(t);
        if (c === 'NSUUID') { const u = this.uuidObj(); out[k] = u.uid; uuid = u.id; }
        else if (c && CONTAINER.test(c)) out[k] = this.container(c);
        else out[k] = v;
      }
    } else {
      const spec = OBJECTS[className];
      if (!spec) throw new Error(`No template for ${className}`);
      for (const [k, v] of Object.entries(spec)) {
        if (k === '$class') continue;
        const r = this.fromSpec(v);
        out[k] = r.value;
        if (r.uuid) uuid = r.uuid;
      }
    }
    for (const [k, v] of Object.entries(overrides)) out[k] = typeof v === 'string' ? this.str(v) : v;
    return { uid: this.add(out), obj: out, uuid };
  }

  fromSpec(v) {
    if (v === null) return { value: new UID(0) };
    if (typeof v !== 'object') return { value: v };
    if ('$real' in v) return { value: real(v.$real) };
    if ('$str' in v) return { value: this.str(v.$str) };
    if ('$uuid' in v) { const u = this.uuidObj(); return { value: u.uid, uuid: u.id }; }
    if ('$empty' in v) return { value: this.container(v.$empty) };
    if ('$data' in v) return { value: this.add(new Uint8Array(0)) };
    if ('$class' in v) {
      const o = { $class: this.classUID(v.$class) };
      for (const [k, x] of Object.entries(v)) if (k !== '$class') o[k] = this.fromSpec(x).value;
      return { value: this.add(o) };
    }
    return { value: new UID(0) };
  }

  items(uidOrObj) { return this.D(uidOrObj)['NS.objects']; }

  // ---- what's in the project -----------------------------------------------------------------------------

  panels() { return this.items(this.top.livePanels).map((u) => ({ uid: u, obj: this.D(u) })); }

  panelByUUID(id) {
    return this.panels().find((p) => this.uuidOf(p.obj) === id) || null;
  }

  uuidOf(o) {
    const u = this.D(o?.UUID);
    return u?.['NS.uuidbytes'] ? uuidString(u['NS.uuidbytes']) : null;
  }

  defaultButtonSize() {
    const m = /\{\s*([\d.]+)\s*,\s*([\d.]+)\s*\}/.exec(this.S(this.top.defaultCpanButtonSize) || '');
    return m ? [Number(m[1]), Number(m[2])] : [120, 36];
  }

  // ---- builders --------------------------------------------------------------------------------------------

  /** store: a plain JS object { isMutable, umbrellaContainers, effects } (already plist-ready). */
  makePreset(name, storeBytes) {
    const tmpl = this.firstOf('LXPreset');
    const tf = tmpl && this.D(tmpl.fpStore);
    // Same storage form as the project: bare data in $objects, or an NSData wrapper.
    const fp = tf && !(tf instanceof Uint8Array) && tf['NS.data'] ? this.add({ $class: tf.$class, 'NS.data': storeBytes }) : this.add(storeBytes);
    return this.fresh('LXPreset', { fpStore: fp, active: false, name });
  }

  makeFolder(name, children = [], exclusive = false) {
    const f = this.fresh('LXPresetGroup', { name, presetsAreMutuallyExclusive: !!exclusive });
    this.items(f.obj.childNodes).push(...children);
    return f;
  }

  /** The palette folder the editor files its presets into (created on first use). */
  ourFolder(name = 'Lightkey Web') {
    const rootGroup = this.D(this.top.rootPresetGroup);
    const kids = this.items(rootGroup.childNodes);
    for (const k of kids) {
      const o = this.D(k);
      if (this.cls(o) === 'LXPresetGroup' && this.S(o.name) === name) return o;
    }
    const f = this.makeFolder(name);
    kids.push(f.uid);
    return f.obj;
  }

  makeCue(name, presetUIDs, { fadeIn = 0.5, fadeOut = 0.5, priority = 5, intensity = 1 } = {}) {
    const c = this.fresh('LXCue', {
      active: false, name,
      fadeDuration: real(fadeIn), fadeInDuration: real(fadeIn), fadeOutDuration: real(fadeOut),
      priority: Math.round(priority), intensity: real(intensity), holdDuration: real(-1),
      activateAtStartup: false, activateAtShutdown: false,
    });
    this.items(c.obj.presets).push(...presetUIDs);
    // The cue's own orphan-presets group must be a new object too.
    const orphanT = this.D(c.obj.orphanPresetsGroup);
    if (orphanT && typeof orphanT === 'object') {
      const o = { ...orphanT, childNodes: this.container(this.cls(this.D(orphanT.childNodes)) || 'NSArray'), UUID: this.uuidObj().uid };
      c.obj.orphanPresetsGroup = this.add(o);
    }
    return c;
  }

  makeButton(cueUID, rect, { flash = false, color = null } = {}) {
    const r = `{{${Math.round(rect.x)}, ${Math.round(rect.y)}}, {${Math.round(rect.w)}, ${Math.round(rect.h)}}}`;
    return this.fresh('LXCpanButton', {
      cue: cueUID, rect: r, behavior: flash ? 1 : 0, type: 0, vertical: false,
      colorName: color ? this.str(color) : new UID(0), titleFont: new UID(0),
    });
  }

  addPage(name, { priority = 5, fade = 1 } = {}) {
    const own = this.firstOf('LXControlPanel');
    const p = this.fresh('LXControlPanel', { name, fadeDuration: real(fade) });
    if (!own || 'priority' in own) p.obj.priority = Math.round(priority);
    this.items(this.top.livePanels).push(p.uid);
    return p;
  }

  addToPage(panelObj, itemUID) { this.items(panelObj.items).push(itemUID); }

  removeFromPage(panelObj, cueUUID) {
    const list = this.items(panelObj.items);
    const i = list.findIndex((u) => { const b = this.D(u); return this.cls(b) === 'LXCpanButton' && this.uuidOf(this.D(b.cue)) === cueUUID; });
    if (i >= 0) { list.splice(i, 1); return true; }
    for (const u of list) {
      const f = this.D(u);
      if (this.cls(f) !== 'LXCpanFrame') continue;
      const m = this.items(f.members);
      const j = m.findIndex((x) => this.uuidOf(this.D(this.D(x).cue)) === cueUUID);
      if (j >= 0) { m.splice(j, 1); return true; }
    }
    return false;
  }

  /** A user movement path (pan/tilt key positions in radians). Returns its identifier. */
  addMovementPath(name, points, smooth = true, id = `user.${newUUID()}`) {
    // smooth may also be Lightkey's own interpolationMethod number when copying a path from another project.
    const p = this.fresh('LXMovementPath', { name, identifier: id, interpolationMethod: typeof smooth === 'number' ? smooth : smooth ? 1 : 2 });
    const kp = this.items(p.obj.keyPositions);
    for (const [pan, tilt] of points) {
      kp.push(this.fresh('LXFixturePosition', { panAngle: real(pan), tiltAngle: real(tilt) }).uid);
    }
    let paths = this.top.movementPaths;
    if (!paths || this.D(paths) === '$null') { paths = this.container('NSArray'); this.top.movementPaths = paths; }
    this.items(paths).push(p.uid);
    return id;
  }

  bytes() { return writeBplist(this.root); }
}

export { real, Real, UID };
