'use strict';
const CACHE_VER    = 'nexcall-v2';
const CACHE_STATIC = `${CACHE_VER}-static`;
const SHELL = [
  '/', '/index.html', '/app.js', '/db.js', '/manifest.json',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_STATIC).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_STATIC).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(res => {
      if (res && res.status === 200) { const clone = res.clone(); caches.open(CACHE_STATIC).then(c => c.put(request, clone)); }
      return res;
    }).catch(() => { if (request.mode === 'navigate') return caches.match('/index.html'); });
  }));
});
self.addEventListener('message', e => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });

