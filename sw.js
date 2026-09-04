const CACHE_NAME = 'meufinanceiro-v3';
const APP_SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

// arquivos do "miolo" do app: sempre tenta buscar a versão mais nova primeiro,
// assim toda atualização que eu mandar já aparece na próxima vez que abrir
// (com internet). Sem internet, cai pro que estiver em cache.
const NETWORK_FIRST = ['index.html', 'app.js', './', ''];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAppShellFile(url){
  const path = new URL(url).pathname;
  return NETWORK_FIRST.some(f => path.endsWith(f) || path.endsWith('/'+f));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (isAppShellFile(event.request.url)) {
    // network-first: busca a versão nova; se não conseguir (offline), usa o cache
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // resto (ícones, fontes, motor de OCR): cache-first, não muda com frequência
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
