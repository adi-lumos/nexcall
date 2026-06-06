'use strict';

// ALL data stays in IndexedDB on the user's own browser/device.
// Nothing here ever contacts a server. The server has no database.

const DB_NAME    = 'nexcall-local';
const DB_VERSION = 1;
let _db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('contacts')) {
        const s = db.createObjectStore('contacts', { keyPath: 'id', autoIncrement: true });
        s.createIndex('roomId', 'roomId', { unique: false });
        s.createIndex('name',   'name',   { unique: false });
      }
      if (!db.objectStoreNames.contains('callHistory')) {
        const s = db.createObjectStore('callHistory', { keyPath: 'id', autoIncrement: true });
        s.createIndex('roomId',    'roomId',    { unique: false });
        s.createIndex('startedAt', 'startedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function txWrite(store, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(store, 'readwrite');
    const req = fn(t.objectStore(store));
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function txRead(store, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(store, 'readonly');
    const req = fn(t.objectStore(store));
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

const AVATAR_COLORS = ['#0f6e56','#185fa5','#854f0b','#993c1d','#534ab7','#72243e'];
function randomColor() { return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]; }

export function saveContact({ name, roomId, avatarColor }) {
  return txWrite('contacts', s => s.add({
    name, roomId,
    avatarColor: avatarColor || randomColor(),
    addedAt: Date.now(), lastCalledAt: null,
  }));
}
export function getContacts()      { return txRead('contacts',    s => s.getAll()); }
export function deleteContact(id)  { return txWrite('contacts',   s => s.delete(id)); }

export function touchContact(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('contacts', 'readwrite');
    const s = t.objectStore('contacts');
    const g = s.get(id);
    g.onsuccess = e => {
      const c = e.target.result;
      if (!c) return resolve(null);
      c.lastCalledAt = Date.now();
      const p = s.put(c);
      p.onsuccess = () => resolve(c);
      p.onerror   = ev => reject(ev.target.error);
    };
    g.onerror = e => reject(e.target.error);
  }));
}

export function logCallStart({ roomId, contactName, direction }) {
  return txWrite('callHistory', s => s.add({
    roomId, contactName: contactName || roomId, direction,
    startedAt: Date.now(), endedAt: null, durationSeconds: null, status: 'ongoing',
  }));
}

export function logCallEnd(id, status = 'completed') {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction('callHistory', 'readwrite');
    const s = t.objectStore('callHistory');
    const g = s.get(id);
    g.onsuccess = e => {
      const r = e.target.result;
      if (!r) return resolve(null);
      r.endedAt = Date.now();
      r.durationSeconds = Math.round((r.endedAt - r.startedAt) / 1000);
      r.status = status;
      const p = s.put(r);
      p.onsuccess = () => resolve(r);
      p.onerror   = ev => reject(ev.target.error);
    };
    g.onerror = e => reject(e.target.error);
  }));
}

export function getCallHistory(limit = 100) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const idx     = db.transaction('callHistory','readonly').objectStore('callHistory').index('startedAt');
    const results = [];
    const req     = idx.openCursor(null, 'prev');
    req.onsuccess = e => {
      const c = e.target.result;
      if (c && results.length < limit) { results.push(c.value); c.continue(); }
      else resolve(results);
    };
    req.onerror = e => reject(e.target.error);
  }));
}

export function clearCallHistory()    { return txWrite('callHistory', s => s.clear()); }
export function setSetting(key, value){ return txWrite('settings', s => s.put({ key, value })); }
export function getSetting(key, fb=null) {
  return txRead('settings', s => s.get(key)).then(r => r ? r.value : fb);
}

export async function exportAllData() {
  const [contacts, callHistory] = await Promise.all([getContacts(), getCallHistory(100000)]);
  const blob = new Blob(
    [JSON.stringify({ exportedAt: new Date().toISOString(), contacts, callHistory }, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), {
    href: url, download: `nexcall-backup-${new Date().toISOString().slice(0,10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

export async function eraseAllData() {
  await Promise.all(['contacts','callHistory','settings'].map(store => txWrite(store, s => s.clear())));
  console.log('[DB] All local data erased.');
}

