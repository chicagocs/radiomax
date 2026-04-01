// v4.73 <- Incrementar versión cada vez que haya cambios para forzar la actualización
const CACHE_VERSION = 'v4.73';
const STATIC_CACHE = `max-static-${CACHE_VERSION}`;
const API_CACHE = `max-api-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/stations.json',
  '/site.webmanifest',
  '/images/apple-touch-icon.png',
  '/images/favicon-32x32.png',
  '/images/favicon-16x16.png',
  '/images/web-app-manifest-192x192.png',
  '/images/web-app-manifest-512x512.png'
];

const API_CACHE_TTL = 5 * 60 * 1000;
const MAX_API_CACHE_SIZE = 50;
const BLOCKED_HOSTS = ['stats.max.com', 'stats.tramax.com.ar'];
const API_HOSTS = ['api.somafm.com','api.radioparadise.com','musicbrainz.org','radiomax.pages.dev','core.chcs.workers.dev'];

// ==========================================================================
// FUNCIÓN DE CACHEO FORZADO
// ==========================================================================
async function addAssetIgnoringHeaders(cache, url) {
  try {
    const response = await fetch(url, { cache: 'no-cache', mode: 'cors' });
    if (!response.ok) throw new Error(`Status ${response.status} for ${url}`);
    
    const body = await response.blob();
    const newHeaders = new Headers();
    
    response.headers.forEach((value, key) => {
      if (!['cache-control', 'expires', 'pragma'].includes(key.toLowerCase())) {
        newHeaders.set(key, value);
      }
    });

    newHeaders.set('Cache-Control', 'public, max-age=31536000');
    if (!newHeaders.has('Content-Type')) newHeaders.set('Content-Type', 'text/html');

    const newResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });

    await cache.put(url, newResponse);
  } catch (err) {
    console.error(`[SW] Failed to force cache ${url}:`, err);
    throw err;
  }
}

// ==========================================================================
// INSTALACIÓN (Corregido: Un solo listener)
// ==========================================================================
self.addEventListener('install', event => {
  console.log(`[SW] Instalando versión ${CACHE_VERSION}`);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        return Promise.allSettled(
          STATIC_ASSETS.map(url => addAssetIgnoringHeaders(cache, url))
        );
      })
      .then(() => self.skipWaiting()) // Fuerza la activación inmediata
  );
});

// ==========================================================================
// ACTIVACIÓN (Corregido: Faltaba este bloque clave)
// ==========================================================================
self.addEventListener('activate', event => {
  console.log(`[SW] Activando versión ${CACHE_VERSION}`);
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        // Borra cachés antiguos que no coincidan con la versión actual
        cacheNames.filter(cacheName => {
          return cacheName !== STATIC_CACHE && cacheName !== API_CACHE;
        }).map(cacheName => {
          console.log(`[SW] Borrando caché antigua: ${cacheName}`);
          return caches.delete(cacheName);
        })
      );
    }).then(() => self.clients.claim()) // Toma control de las páginas abiertas inmediatamente
  );
});

// ==========================================================================
// FETCH (Sin cambios funcionales, solo limpieza)
// ==========================================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (BLOCKED_HOSTS.some(host => url.hostname.includes(host))) return;
  
  if (request.method !== 'GET' && !url.hostname.includes('core.chcs.workers.dev')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (STATIC_ASSETS.some(asset => url.pathname === asset || url.pathname === asset.replace(/\/$/, ''))) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  if (API_HOSTS.some(host => url.hostname.includes(host))) {
    event.respondWith(networkFirstWithTTL(request, API_CACHE));
    return;
  }

  event.respondWith(fetch(request));
});

// ==========================================================================
// MENSAJES
// ==========================================================================
self.addEventListener('message', event => {
  const { type } = event.data || {};
  if (type === 'SKIP_WAITING') self.skipWaiting();
});

// ==========================================================================
// ESTRATEGIAS
// ==========================================================================
async function handleNavigation(request) {
  try {
    const response = await fetch(request.url);
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await caches.match('/offline.html', { cacheName: STATIC_CACHE });
    return cached || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(async (response) => {
    if (response?.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}

async function networkFirstWithTTL(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  
  if (cached) {
    const cachedTime = cached.headers.get('sw-cached-time');
    if (cachedTime && (Date.now() - new Date(cachedTime).getTime() < API_CACHE_TTL)) {
      return cached;
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set('sw-cached-time', new Date().toISOString());
      const responseToCache = new Response(response.clone().body, {
        status: response.status, statusText: response.statusText, headers
      });
      // Limpieza de caché simplificada para evitar bloqueos
      safeCachePut(cache, request, responseToCache);
    }
    return response;
  } catch (error) {
    return cached || new Response(JSON.stringify({ error: 'Network unavailable' }), { status: 408, headers: { 'Content-Type': 'application/json' } });
  }
}

async function safeCachePut(cache, request, response) {
  try {
    const keys = await cache.keys();
    if (keys.length >= MAX_API_CACHE_SIZE) {
        // Borra el primero si se llena
        await cache.delete(keys[0]);
    }
    await cache.put(request, response);
  } catch (e) { console.warn('[SW] Cache put error', e); }
}
