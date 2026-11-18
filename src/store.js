// Remembers recently opened files in this browser (IndexedDB) so a reload brings the show back, and which MVR
// goes with which project. Everything stays local to this browser. Failures are ignored: the app works without it.
const DB = 'lightkey-web';
const STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const out = fn(s);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export async function saveFile(kind, name, bytes, extra = {}) {
  try { await tx('readwrite', (s) => s.put({ key: `${kind}:${name}`, kind, name, bytes, savedAt: Date.now(), ...extra })); } catch {}
}

export async function getFile(kind, name) {
  try { return await tx('readonly', (s) => s.get(`${kind}:${name}`)); } catch { return null; }
}

export async function listFiles(kind) {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return all.filter((f) => f.kind === kind).sort((a, b) => b.savedAt - a.savedAt).map(({ name, savedAt, mvr, bytes }) => ({ name, savedAt, mvr, size: bytes?.length || 0 }));
  } catch { return []; }
}

export async function removeFile(kind, name) {
  try { await tx('readwrite', (s) => s.delete(`${kind}:${name}`)); } catch {}
}

export function getPref(k, d) { try { const v = localStorage.getItem(`lkweb.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } }
export function setPref(k, v) { try { localStorage.setItem(`lkweb.${k}`, JSON.stringify(v)); } catch {} }
