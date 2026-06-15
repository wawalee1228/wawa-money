// ============================================================================
// sw.js — Service Worker：讓 App 可離線開啟（§15 PWA 可離線）
// 策略：預先快取殼層檔；資料完全存 IndexedDB，不經過這裡。
// 改版時把 CACHE 版本號 +1 即可讓使用者拿到新檔。
// ============================================================================
const CACHE = 'wawa-shell-v51';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/calc.js',
  './js/date.js',
  './js/txns.js',
  './js/parse.js',
  './js/dedup.js',
  './js/backup.js',
  './js/report.js',
  './js/ui.js',
  './js/selftest.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // 「網路優先」：線上一律拿最新程式並順手更新快取；離線時才退回快取。
  // （避免快取住舊版 JS 導致「改了卻沒生效」。資料仍全在 IndexedDB，不經這裡。）
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
