// NSKeyedArchiver decoder: turns the flat $objects table back into an object graph.
// Foundation collections become plain arrays / objects, strings become strings, NSUUID becomes an upper-case
// UUID string (the form Lightkey uses as keys inside preset stores), NSData becomes Uint8Array, NSValue points
// become [x, y]. Every other archived class becomes { $class: 'LXSomething', ...fields }. Shared objects stay
// shared (the same JS object), so identity can be used to tell when two cues reference the same preset.
import { parseBplist, UID } from './bplist.js';

const uuidString = (b) => {
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const parsePoint = (s) => {
  const m = /\{\s*(-?[\d.e+-]+)\s*,\s*(-?[\d.e+-]+)\s*\}/.exec(s || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export const parseRect = (s) => {
  const n = String(s || '').match(/-?[\d.]+(?:e[+-]?\d+)?/g)?.map(Number);
  return n && n.length >= 4 ? { x: n[0], y: n[1], w: n[2], h: n[3] } : null;
};

export function unarchive(input) {
  const root = input instanceof Uint8Array || input instanceof ArrayBuffer ? parseBplist(input) : input;
  if (!root || !root.$objects) throw new Error('Not a keyed archive');
  const objs = root.$objects;
  const cache = new Map();

  const conv = (v) => (v instanceof UID ? dec(v.UID) : v);
  const className = (o) => objs[o.$class.UID]?.$classname;

  function dec(uid) {
    if (cache.has(uid)) return cache.get(uid);
    const o = objs[uid];
    if (o === '$null') return null;
    if (o && typeof o === 'object' && !(o instanceof Uint8Array) && o.$class instanceof UID) {
      const cls = className(o);
      if (/^NS(Mutable)?(Array|Set|OrderedSet)$/.test(cls)) {
        const res = [];
        cache.set(uid, res);
        for (const x of o['NS.objects'] || []) res.push(conv(x));
        return res;
      }
      if (/^NS(Mutable)?Dictionary$/.test(cls)) {
        const res = {};
        cache.set(uid, res);
        (o['NS.keys'] || []).forEach((k, i) => { res[String(conv(k))] = conv(o['NS.objects'][i]); });
        return res;
      }
      if (/^NS(Mutable)?String$/.test(cls)) return o['NS.string'];
      if (/^NS(Mutable)?AttributedString$|^NSTextStorage$/.test(cls)) return conv(o.NSString);
      if (cls === 'NSUUID') { const s = uuidString(o['NS.uuidbytes']); cache.set(uid, s); return s; }
      if (/^NS(Mutable)?Data$/.test(cls)) return o['NS.data'];
      if (cls === 'NSValue' && o['NS.pointval'] != null) return parsePoint(conv(o['NS.pointval']));
      const res = { $class: cls };
      cache.set(uid, res);
      for (const [k, v] of Object.entries(o)) if (k !== '$class') res[k] = conv(v);
      return res;
    }
    return conv(o);
  }

  const top = root.$top;
  if (top.root) return dec(top.root.UID);
  const res = {};
  for (const [k, v] of Object.entries(top)) res[k] = conv(v);
  return res;
}

/** A nested store (fpStore, effect parameters, curve data) can be a plain binary plist or a keyed archive. */
export function decodeNested(bytes) {
  if (!bytes) return null;
  const p = parseBplist(bytes);
  return p && p.$objects && p.$archiver ? unarchive(p) : p;
}
