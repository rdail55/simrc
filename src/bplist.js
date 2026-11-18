// Binary property list (bplist00) reader. Works in the browser and in Node (takes a Uint8Array / ArrayBuffer).
// Dictionaries become plain objects (key order kept), arrays and sets become arrays, data becomes Uint8Array,
// dates become Date, keyed-archiver references become UID instances.

export class UID {
  constructor(n) { this.UID = n; }
}

/** A floating-point value that must stay a real when written back (raw mode keeps 1.0 distinct from 1). */
export class Real {
  constructor(v) { this.value = v; }
  valueOf() { return this.value; }
}
export const real = (v) => new Real(Number(v));

/** opts.raw: reals come back as Real so a file can be written back without changing any types. */
export function parseBplist(input, opts = {}) {
  const raw = !!opts.raw;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (!magic.startsWith('bplist0')) throw new Error('Not a binary plist');

  const t = bytes.length - 32;
  const offsetSize = bytes[t + 6];
  const refSize = bytes[t + 7];
  const numObjects = readUInt(t + 8, 8);
  const topObject = readUInt(t + 16, 8);
  const tableOffset = readUInt(t + 24, 8);

  function readUInt(pos, size) {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[pos + i];
    return v;
  }

  function readInt(pos, size) {
    if (size === 1) return bytes[pos];
    if (size === 2) return dv.getUint16(pos);
    if (size === 4) return dv.getUint32(pos);
    if (size === 8) {
      const big = dv.getBigInt64(pos);
      const n = Number(big);
      return Number.isSafeInteger(n) ? n : big;
    }
    if (size === 16) return Number(dv.getBigInt64(pos + 8)); // 128-bit ints only show up for large unsigned values
    throw new Error(`Bad int size ${size}`);
  }

  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = readUInt(tableOffset + i * offsetSize, offsetSize);

  const cache = new Map();

  function lengthAt(pos, info) {
    if (info !== 0xf) return [info, pos + 1];
    const marker = bytes[pos + 1];
    const size = 1 << (marker & 0xf);
    return [readInt(pos + 2, size), pos + 2 + size];
  }

  function obj(ref) {
    if (cache.has(ref)) return cache.get(ref);
    const pos = offsets[ref];
    const marker = bytes[pos];
    const type = marker >> 4, info = marker & 0xf;
    let v;
    switch (type) {
      case 0x0:
        v = info === 0x8 ? false : info === 0x9 ? true : null;
        break;
      case 0x1:
        v = readInt(pos + 1, 1 << info);
        break;
      case 0x2:
        v = info === 2 ? dv.getFloat32(pos + 1) : dv.getFloat64(pos + 1);
        if (raw) v = new Real(v);
        break;
      case 0x3:
        v = new Date(Date.UTC(2001, 0, 1) + dv.getFloat64(pos + 1) * 1000);
        break;
      case 0x4: {
        const [len, start] = lengthAt(pos, info);
        v = bytes.slice(start, start + len);
        break;
      }
      case 0x5: {
        const [len, start] = lengthAt(pos, info);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
        v = s;
        break;
      }
      case 0x6: {
        const [len, start] = lengthAt(pos, info);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(start + i * 2));
        v = s;
        break;
      }
      case 0x8:
        v = new UID(readUInt(pos + 1, info + 1));
        break;
      case 0xa: case 0xc: {
        const [len, start] = lengthAt(pos, info);
        v = [];
        cache.set(ref, v);
        for (let i = 0; i < len; i++) v.push(obj(readUInt(start + i * refSize, refSize)));
        return v;
      }
      case 0xd: {
        const [len, start] = lengthAt(pos, info);
        v = {};
        cache.set(ref, v);
        for (let i = 0; i < len; i++) {
          const k = obj(readUInt(start + i * refSize, refSize));
          v[String(k)] = obj(readUInt(start + (len + i) * refSize, refSize));
        }
        return v;
      }
      default:
        throw new Error(`Unknown plist object type 0x${marker.toString(16)}`);
    }
    cache.set(ref, v);
    return v;
  }

  return obj(topObject);
}

export const isBplist = (bytes) => bytes.length > 8 && bytes[0] === 0x62 && bytes[1] === 0x70 && bytes[2] === 0x6c;

// ---- writer -------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

/**
 * Write a value as bplist00. Numbers that are integers become ints (use Real / real() to force a real),
 * non-integer numbers become reals, BigInt is a 64-bit int, Uint8Array is data, UID is a keyed-archive reference.
 * Equal scalars are stored once, like Apple's writer.
 */
export function writeBplist(root) {
  const objects = []; // { marker bytes builder }
  const scalarIndex = new Map();
  const refsOf = new Map(); // container object → index

  function add(v) {
    if (v !== null && typeof v === 'object' && !(v instanceof UID) && !(v instanceof Real) && !(v instanceof Uint8Array) && !(v instanceof Date)) {
      if (refsOf.has(v)) return refsOf.get(v);
      const idx = objects.length;
      refsOf.set(v, idx);
      if (Array.isArray(v)) {
        const entry = { type: 'array', refs: null };
        objects.push(entry);
        entry.refs = v.map(add);
      } else {
        const entry = { type: 'dict', keys: null, refs: null };
        objects.push(entry);
        const ks = Object.keys(v);
        entry.keys = ks.map(add);
        entry.refs = ks.map((k) => add(v[k]));
      }
      return idx;
    }
    const key = scalarKey(v);
    if (key != null && scalarIndex.has(key)) return scalarIndex.get(key);
    const idx = objects.length;
    objects.push({ type: 'scalar', value: v });
    if (key != null) scalarIndex.set(key, idx);
    return idx;
  }

  function scalarKey(v) {
    if (v === null || v === undefined) return 'n';
    if (typeof v === 'boolean') return `b${v}`;
    if (typeof v === 'string') return `s${v}`;
    if (v instanceof Real) return `r${Object.is(v.value, -0) ? '-0' : v.value}`;
    if (typeof v === 'number') return Number.isInteger(v) ? `i${v}` : `r${v}`;
    if (typeof v === 'bigint') return `i${v}`;
    if (v instanceof UID) return `u${v.UID}`;
    return null; // data and dates are not uniqued
  }

  add(root);
  const n = objects.length;
  const refSize = n < 256 ? 1 : n < 65536 ? 2 : 4;

  const chunks = [];
  let size = 0;
  const offsets = [];
  const push = (u8) => { chunks.push(u8); size += u8.length; };

  function header(type, len) {
    if (len < 15) return [(type << 4) | len];
    const ib = intBytes(len);
    return [(type << 4) | 0xf, ...ib];
  }
  function intBytes(v) {
    // An int object (marker + big-endian bytes), smallest unsigned width that fits; negatives use 8 bytes.
    if (typeof v === 'bigint' || v < 0 || v > 0xffffffff) {
      const b = new Uint8Array(9); b[0] = 0x13;
      new DataView(b.buffer).setBigInt64(1, BigInt(v));
      return [...b];
    }
    if (v < 256) return [0x10, v];
    if (v < 65536) return [0x11, v >> 8, v & 0xff];
    return [0x12, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  const refBytes = (r) => (refSize === 1 ? [r] : refSize === 2 ? [r >> 8, r & 0xff] : [(r >>> 24) & 0xff, (r >>> 16) & 0xff, (r >>> 8) & 0xff, r & 0xff]);

  push(enc.encode('bplist00'));
  for (const o of objects) {
    offsets.push(size);
    if (o.type === 'array') {
      push(new Uint8Array([...header(0xa, o.refs.length), ...o.refs.flatMap(refBytes)]));
    } else if (o.type === 'dict') {
      push(new Uint8Array([...header(0xd, o.keys.length), ...o.keys.flatMap(refBytes), ...o.refs.flatMap(refBytes)]));
    } else {
      const v = o.value;
      if (v === null || v === undefined) push(new Uint8Array([0x00]));
      else if (v === false) push(new Uint8Array([0x08]));
      else if (v === true) push(new Uint8Array([0x09]));
      else if (v instanceof UID) {
        const u = v.UID;
        push(new Uint8Array(u < 256 ? [0x80, u] : u < 65536 ? [0x81, u >> 8, u & 0xff] : [0x83, (u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff]));
      } else if (v instanceof Real || (typeof v === 'number' && !Number.isInteger(v))) {
        const b = new Uint8Array(9); b[0] = 0x23;
        new DataView(b.buffer).setFloat64(1, Number(v));
        push(b);
      } else if (typeof v === 'number' || typeof v === 'bigint') push(new Uint8Array(intBytes(v)));
      else if (v instanceof Date) {
        const b = new Uint8Array(9); b[0] = 0x33;
        new DataView(b.buffer).setFloat64(1, (v.getTime() - Date.UTC(2001, 0, 1)) / 1000);
        push(b);
      } else if (v instanceof Uint8Array) {
        push(new Uint8Array(header(0x4, v.length)));
        push(v);
      } else if (typeof v === 'string') {
        if (isAscii(v)) {
          push(new Uint8Array(header(0x5, v.length)));
          push(enc.encode(v));
        } else {
          const b = new Uint8Array(v.length * 2);
          const dv = new DataView(b.buffer);
          for (let i = 0; i < v.length; i++) dv.setUint16(i * 2, v.charCodeAt(i));
          push(new Uint8Array(header(0x6, v.length)));
          push(b);
        }
      } else throw new Error(`Can't write ${typeof v} to a plist`);
    }
  }
  const tableOffset = size;
  const offSize = tableOffset < 256 ? 1 : tableOffset < 65536 ? 2 : tableOffset < 2 ** 24 ? 3 : 4;
  const table = new Uint8Array(n * offSize);
  offsets.forEach((o, i) => { for (let k = 0; k < offSize; k++) table[i * offSize + k] = Math.floor(o / 256 ** (offSize - 1 - k)) & 0xff; });
  push(table);
  const trailer = new Uint8Array(32);
  const tv = new DataView(trailer.buffer);
  trailer[6] = offSize;
  trailer[7] = refSize;
  tv.setBigUint64(8, BigInt(n));
  tv.setBigUint64(16, 0n);
  tv.setBigUint64(24, BigInt(tableOffset));
  push(trailer);

  const out = new Uint8Array(size);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
