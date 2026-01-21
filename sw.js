// v4.3
// Para reflejar cambios en recursos estáticos (CSS, JS, Imágenes) cambiar CACHE_VERSION
const CACHE_VERSION = 'v4.3';
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

const API_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const MAX_API_CACHE_SIZE = 50; // Límite de entradas en caché API
const BLOCKED_HOSTS = ['stats.max.com', 'stats.tramax.com.ar'];
const API_HOSTS = ['api.somafm.com','api.radioparadise.com','musicbrainz.org','radiomax.pages.dev','core.chcs.workers.dev'];

// ==========================================================================
// FUNCIÓN DE CACHEO FORZADO (Ignora headers restrictivos del servidor)
// ==========================================================================

async function addAssetIgnoringHeaders(cache, url) {
  try {
    // 1. Hacemos el fetch manualmente. 
    // cache: 'no-cache' evita que el navegador entregue una versión vieja de su caché,
    // forzando que pregunte al servidor.
    const response = await fetch(url, {
      cache: 'no-cache',
      mode: 'cors' 
    });

    if (!response.ok) {
      throw new Error(`Status ${response.status} for ${url}`);
    }

    // 2. Leemos el cuerpo de la respuesta una sola vez.
    // Usamos .blob() o .text() porque necesitamos el contenido para la nueva Response.
    const body = await response.blob();

    // 3. Creamos un objeto de cabeceras limpio.
    // Copiamos todo MENOS las restricciones de caché.
    const newHeaders = new Headers();
    
    // Copiamos headers útiles (tipo de contenido, etc.)
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      // Ignoramos headers que prohíben cachear
      if (
!['cache-control', 'expires', 'pragma'].includes(lowerKey)
) {
        newHeaders.set(key, value);
      }
    });

    // 4. Forzamos nuestras propias cabeceras de caché para que el SW la guarde
    newHeaders.set('Cache-Control', 'public, max-age=31536000'); // 1 año
    // Mantenemos el Content-Type para que el navegador sepa que es HTML
    if (!newHeaders.has('Content-Type')) {
      newHeaders.set('Content-Type', 'text/html'); 
    }

    // 5. Creamos una NUEVA Response con el mismo cuerpo pero cabeceras nuevas
    const newResponse = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });

    // 6. Guardamos en caché
    await cache.put(url, newResponse);
    console.log(`[SW] Force cached: ${url}`);

  } catch (err) {
    console.error(`[SW] Failed to force cache ${url}:`, err);
    throw err; // Importante lanzar el error para que Promise.allSettled lo capture
  }
}

// ==========================================================================
// INSTALACIÓN
// ==========================================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        // Pre-cachear en paralelo con manejo de errores individual
        return Promise.allSettled(
          STATIC_ASSETS.map(url => 
            cache.add(url).catch(err => {
              console.error('[SW] Install failed for:', url, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ==========================================================================
// ACTIVACIÓN
// ==========================================================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        return Promise.allSettled(
          STATIC_ASSETS.map(url => 
            // Aquí usamos la nueva función en lugar de cache.add(url)
            addAssetIgnoringHeaders(cache, url).catch(err => {
              console.error('[SW] Install failed for:', url, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ==========================================================================
// FETCH
// ==========================================================================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar hosts bloqueados (analytics)
  if (BLOCKED_HOSTS.some(host => url.hostname.includes(host))) {
    return;
  }

  // Ignorar requests no-GET que no sean de APIs conocidas
  if (request.method !== 'GET' && !url.hostname.includes('core.chcs.workers.dev')) {
    return;
  }

  // Navegación: Network-first con fallback a offline
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Assets estáticos: Stale-While-Revalidate
  if (STATIC_ASSETS.some(asset => url.pathname === asset || url.pathname === asset.replace(/\/$/, ''))) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  // APIs: Network-first con TTL
  if (API_HOSTS.some(host => url.hostname.includes(host))) {
    event.respondWith(networkFirstWithTTL(request, API_CACHE));
    return;
  }

  // Resto: Network only
  event.respondWith(fetch(request));
});

// ==========================================================================
// MENSAJES
// ==========================================================================
self.addEventListener('message', event => {
  const { type, data } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
    
    case 'DEBUG_CACHE_STATUS':
      debugCacheStatus(event);
      break;
    
    case 'CLEAR_API_CACHE':
      caches.delete(API_CACHE).then(() => {
        event.ports[0]?.postMessage({ success: true });
      });
      break;
  }
});

// ==========================================================================
// ESTRATEGIAS DE CACHÉ
// ==========================================================================

async function handleNavigation(request) {
  try {
    // FIX: Crear una nueva petición usando la URL como string.
    // Esto evita el error "Failed to fetch" causado por reutilizar el objeto 'request' original.
    const response = await fetch(request.url);

    // Cachear HTML exitoso
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const cache = await caches.open(STATIC_CACHE);
      // PUT requests with `response.clone()` are handled differently by some browsers,
      // but since we are fetching a fresh request, this works well.
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    // Fallback a offline.html
    return caches.match('/offline.html', { cacheName: STATIC_CACHE }) ||
           new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Fetch en segundo plano
  const fetchPromise = fetch(request).then(async (response) => {
    if (response?.ok) {
      cache.put(request, response.clone()).catch(err => {
        console.warn('[SW] Cache put failed:', err.message);
      });
    }
    return response;
  }).catch(() => cached); // Fallback a caché si falla

  // Retornar inmediatamente lo cacheado o esperar el fetch
  return cached || fetchPromise;
}

async function networkFirstWithTTL(request, cacheName) {
  const cache = await caches.open(cacheName);
  
  // Verificar caché con TTL
  const cached = await cache.match(request);
  if (cached) {
    const cachedTime = cached.headers.get('sw-cached-time');
    if (cachedTime) {
      const age = Date.now() - new Date(cachedTime).getTime();
      if (age < API_CACHE_TTL) {
        return cached;
      }
    }
  }

  // Intentar fetch
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Clonar y agregar timestamp
      const headers = new Headers(response.headers);
      headers.set('sw-cached-time', new Date().toISOString());
      
      const responseToCache = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });

      // Gestionar cuota con límite de entradas
      await safeCachePut(cache, request, responseToCache, cacheName);
    }
    return response;
  } catch (error) {
    console.warn('[SW] Network failed:', request.url);
    return cached || new Response(
      JSON.stringify({ error: 'Network unavailable' }), 
      { status: 408, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ==========================================================================
// GESTIÓN DE CUOTA MEJORADA
// ==========================================================================

async function safeCachePut(cache, request, response, cacheName) {
  try {
    // Verificar límite de entradas
    const keys = await cache.keys();
    if (keys.length >= MAX_API_CACHE_SIZE) {
      await evictOldestEntry(cache, request);
    }
    
    await cache.put(request, response);
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      console.warn('[SW] Quota exceeded, evicting old entries');
      const evicted = await evictOldestEntry(cache, request);
      
      if (evicted) {
        try {
          await cache.put(request, response);
        } catch (retryError) {
          console.error('[SW] Retry failed:', retryError.message);
        }
      }
    } else {
      console.error('[SW] Cache put error:', error);
    }
  }
}

async function evictOldestEntry(cache, currentRequest) {
  const keys = await cache.keys();
  if (keys.length === 0) return false;

  // Crear mapa de timestamps
  const entries = await Promise.all(
    keys.map(async (req) => {
      const res = await cache.match(req);
      const time = res?.headers.get('sw-cached-time');
      return {
        request: req,
        timestamp: time ? new Date(time).getTime() : 0
      };
    })
  );

  // Ordenar por más antiguo primero
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Eliminar el más antiguo (excepto el actual)
  for (const entry of entries) {
    if (entry.request.url === currentRequest.url) continue;
    
    try {
      await cache.delete(entry.request);
      console.debug('[SW] Evicted:', entry.request.url);
      return true;
    } catch (err) {
      console.warn('[SW] Eviction failed:', err.message);
    }
  }

  return false;
}

// ==========================================================================
// DIAGNÓSTICO
// ==========================================================================

async function debugCacheStatus(event) {
  try {
    const allKeys = await caches.keys();
    const [quota, usage] = await Promise.all([
      navigator.storage?.estimate() || Promise.resolve({}),
      Promise.resolve(allKeys)
    ]);

    const report = {
      timestamp: new Date().toISOString(),
      version: CACHE_VERSION,
      quota: {
        usage: quota.usage,
        quota: quota.quota,
        percentUsed: quota.quota ? ((quota.usage / quota.quota) * 100).toFixed(2) + '%' : 'N/A'
      },
      caches: {
        static: await getCacheReport(allKeys.filter(k => k.includes('static'))),
        api: await getCacheReport(allKeys.filter(k => k.includes('api')))
      },
      allCacheNames: allKeys
    };

    event.ports[0]?.postMessage({ 
      type: 'DEBUG_CACHE_STATUS_RESPONSE', 
      report 
    });
  } catch (err) {
    event.ports[0]?.postMessage({
      type: 'DEBUG_CACHE_STATUS_RESPONSE',
      error: err.message
    });
  }
}

async function getCacheReport(cacheNames) {
  const report = {};
  
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    
    const entries = await Promise.all(
      keys.map(async (req) => {
        const res = await cache.match(req);
        const time = res?.headers.get('sw-cached-time');
        return {
          url: req.url,
          cachedAt: time || 'N/A',
          ageMs: time ? Date.now() - new Date(time).getTime() : null
        };
      })
    );

    const ages = entries.map(e => e.ageMs).filter(Boolean);
    
    report[name] = {
      entryCount: keys.length,
      oldestAgeMs: ages.length ? Math.max(...ages) : null,
      newestAgeMs: ages.length ? Math.min(...ages) : null,
      sampleEntries: entries.slice(0, 5)
    };
  }
  
  return report;
}
