// Servis çalışanı: uygulamayı çevrimdışı da açılabilir yapar.
// Uygulama dosyalarında değişiklik yaptığında VERSION'ı artır.
const VERSION = 'piano-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/game.js', 'js/renderer.js', 'js/song.js', 'js/notes.js',
  'js/input/InputManager.js', 'js/input/MicInput.js', 'js/input/MidiInput.js',
  'js/input/TouchInput.js', 'js/input/yin.js', 'js/vendor/Midi.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Önce ağ, olmazsa önbellek: güncellemeler hemen gelir, çevrimdışı da çalışır
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
