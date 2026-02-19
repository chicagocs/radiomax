// ==========================================================================
// WORKER PRINCIPAL: core >> index.js (OPTIMIZADO + SEGURO)
// ==========================================================================

// --- CONFIGURACIÓN DE HEADERS ---
const ALLOWED_ORIGIN = "https://radiomax.tramax.com.ar";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0"
};

const securityHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), encrypted-media=(), fullscreen=(self), picture-in-picture=(self), interest-cohort=(), sync-xhr=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://i.scdn.co; connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://*.supabase.co; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload"
};

// Lista blanca de rutas de assets permitidas
const SAFE_ASSET_PATHS = [
  '/index.html',
  '/manifest.json', 
  '/favicon.ico',
  '/robots.txt',
  '/sitemap.xml'
];

// --- GESTIÓN DE TOKEN SPOTIFY (EN MEMORIA) ---
let spotifyTokenCache = {
  token: null,
  expiresAt: 0
};

/**
 * Obtiene o reutiliza el token de Spotify
 */
async function getSpotifyToken(clientId, clientSecret) {
  if (spotifyTokenCache.token && Date.now() < spotifyTokenCache.expiresAt) {
    return spotifyTokenCache.token;
  }

  const authString = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { 
      Authorization: `Basic ${authString}`, 
      "Content-Type": "application/x-www-form-urlencoded" 
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    console.error('[Spotify Auth] Error obteniendo token:', response.status);
    throw new Error("AUTH_ERROR");
  }
  
  const data = await response.json();
  
  // Guardar en caché (expira 1 minuto antes por seguridad)
  spotifyTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000 
  };
  
  return spotifyTokenCache.token;
}

/**
 * Rate limiting básico usando KV
 * Limita a 100 requests por hora por IP
 */
async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return; // Si no hay KV, skip

  const key = `ratelimit:${ip}`;
  const limit = 100; // requests por hora
  
  try {
    const current = await env.RATE_LIMIT_KV.get(key);
    const count = parseInt(current || '0');
    
    if (count >= limit) {
      throw new Error('RATE_LIMIT_EXCEEDED');
    }
    
    await env.RATE_LIMIT_KV.put(
      key, 
      (count + 1).toString(), 
      { expirationTtl: 3600 }
    );
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXCEEDED') throw err;
    console.error('[Rate Limit] Error checking:', err);
    // En caso de error de KV, permitir el request (fail open)
  }
}

/**
 * Valida que el origen del request sea el permitido
 * IMPORTANTE: En producción, considera hacer esto más estricto
 */
function validateOrigin(request) {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  
  // Si tiene Origin header, debe coincidir exactamente
  if (origin) {
    return origin === ALLOWED_ORIGIN;
  }
  
  // Si tiene Referer header, debe empezar con el origen permitido
  if (referer) {
    return referer.startsWith(ALLOWED_ORIGIN);
  }
  
  // SECURITY NOTE: Requests sin Origin ni Referer son permitidos
  // Esto es necesario para:
  // - curl/Postman en desarrollo
  // - Algunos user agents antiguos
  // - Server-to-server requests
  // 
  // Para MÁXIMA seguridad en producción, considera:
  // 1. Retornar 'false' aquí
  // 2. Implementar autenticación por API key
  // 3. Usar Cloudflare Access o similar
  
  // Detectar si es una herramienta de desarrollo
  const userAgent = request.headers.get("User-Agent") || "";
  const isDevelopmentTool = userAgent.includes("curl") || 
                           userAgent.includes("Postman") ||
                           userAgent.includes("Insomnia");
  
  // Por ahora permitimos requests sin headers (comentar la siguiente línea para bloquearlos)
  return false; // Máxima seguridad > Nivel 3
}

// --- HANDLER: SPOTIFY (OPTIMIZADO Y SEGURO) ---
async function handleSpotifyRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));
    const includeGenres = url.searchParams.get("includeGenres") === "true";

    // Validación de parámetros
    if (!artist || !title) {
      return { status: 400, body: JSON.stringify({ error: 'Faltan parámetros requeridos' }) };
    }

    // Validar longitud para prevenir abuse
    if (artist.length > 200 || title.length > 200 || (album && album.length > 200)) {
      return { status: 400, body: JSON.stringify({ error: 'Parámetros demasiado largos' }) };
    }

    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
      console.error('[Spotify] Credenciales no configuradas');
      return { status: 500, body: JSON.stringify({ error: "Servicio no disponible" }) };
    }

    // Obtener token reutilizable
    const accessToken = await getSpotifyToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET);
    let searchData = null;
    let responseSpotify = null;

    // Intento 1: Búsqueda precisa con álbum
    if (album) {
      const q = `track:"${title}" artist:"${artist}" album:"${album}"`;
      responseSpotify = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { 
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(5000) // Timeout 5s
        }
      );
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    // Intento 2: Sin álbum
    if (!searchData || searchData.tracks.items.length === 0) {
      const q = `track:"${title}" artist:"${artist}"`;
      responseSpotify = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { 
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    // Intento 3: Búsqueda laxa
    if (!searchData || searchData.tracks.items.length === 0) {
      const q = `${artist} ${title}`;
      responseSpotify = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { 
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!responseSpotify.ok) {
      console.error('[Spotify Search] Error:', responseSpotify.status);
      throw new Error("SEARCH_ERROR");
    }

    // Procesar resultados
    if (searchData && searchData.tracks.items.length > 0) {
      const track = searchData.tracks.items[0];
      const albumData = track.album;
      const spotifyUrl = track.external_urls?.spotify || "NO_URL";

      // ISRC directo del resultado de búsqueda
      let trackIsrc = track.external_ids?.isrc || null;

      const resp = {
        imageUrl: albumData.images?.[0]?.url ?? null,
        release_date: albumData.release_date ?? null,
        label: albumData.label ?? null,
        genres: [],
        duration: Math.floor(track.duration_ms / 1000),
        totalTracks: albumData.total_tracks ?? null,
        totalAlbumDuration: 0,
        trackNumber: track.track_number,
        albumTypeDescription: getAlbumTypeDescription(albumData),
        isrc: trackIsrc,
        links: null,
        debugSpotifyUrl: spotifyUrl
      };

      // Fetch detalles del álbum solo si es necesario
      if (albumData.id && (!resp.label || resp.totalAlbumDuration === 0)) {
        try {
          const full = await fetch(
            `https://api.spotify.com/v1/albums/${albumData.id}`,
            { 
              headers: { Authorization: `Bearer ${accessToken}` },
              signal: AbortSignal.timeout(3000)
            }
          );
          if (full.ok) {
            const fullAlbum = await full.json();
            resp.label = fullAlbum.label ?? resp.label;
            if (fullAlbum.tracks?.items) {
              resp.totalAlbumDuration = fullAlbum.tracks.items.reduce(
                (sum, t) => sum + (t.duration_ms || 0), 
                0
              );
            }
          }
        } catch (err) {
          console.warn('[Spotify Album] Error fetching details:', err.message);
        }
      }

      // Géneros (solo si se solicita explícitamente)
      if (includeGenres && track.artists.length > 0) {
        const tasks = track.artists.slice(0, 2).map(async (a) => {
          try {
            const r = await fetch(
              `https://api.spotify.com/v1/artists/${a.id}`,
              { 
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(2000)
              }
            );
            return r.ok ? (await r.json()).genres ?? [] : [];
          } catch {
            return [];
          }
        });
        
        const results = await Promise.allSettled(tasks);
        resp.genres = [...new Set(
          results
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value)
        )];
      }

      return { status: 200, body: JSON.stringify(resp) };
    }
    
    return { 
      status: 404, 
      body: JSON.stringify({ error: "Track no encontrado" }) 
    };
    
  } catch (err) {
    console.error('[Spotify Handler] Error:', err.message);
    
    // Mensajes de error genéricos para el cliente
    if (err.message === 'AUTH_ERROR') {
      return { status: 503, body: JSON.stringify({ error: "Servicio temporalmente no disponible" }) };
    }
    
    if (err.name === 'TimeoutError') {
      return { status: 504, body: JSON.stringify({ error: "Timeout en búsqueda" }) };
    }
    
    return { 
      status: 500, 
      body: JSON.stringify({ error: "Error procesando solicitud" }) 
    };
  }
}

// --- HANDLER: ODESLI (CON CACHE MEJORADO) ---
async function handleOdesliProxyRequest(request, env, ctx) {
  const url = new URL(request.url);
  const spotifyUrl = url.searchParams.get("url");
  
  if (!spotifyUrl || spotifyUrl === "NO_URL") {
    return { 
      status: 400, 
      body: JSON.stringify({ error: "URL inválida" }) 
    };
  }

  // Validar que sea una URL de Spotify
  if (!spotifyUrl.startsWith('https://open.spotify.com/')) {
    return { 
      status: 400, 
      body: JSON.stringify({ error: "Solo URLs de Spotify permitidas" }) 
    };
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url);

  try {
    // Intentar obtener del cache
    let cached = await cache.match(cacheKey);
    if (cached) {
      console.log("[Odesli] Cache HIT");
      return { status: 200, body: await cached.text() };
    }

    console.log("[Odesli] Cache MISS");
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://song.link/'
    };

    const response = await fetch(apiUrl, { 
      headers,
      signal: AbortSignal.timeout(8000) 
    });

    if (!response.ok) {
      console.error('[Odesli] API Error:', response.status);
      if (response.status === 429) {
        return { 
          status: 429, 
          body: JSON.stringify({ error: "Servicio temporalmente saturado" }) 
        };
      }
      return { 
        status: response.status, 
        body: JSON.stringify({ error: "Error obteniendo enlaces" }) 
      };
    }

    const data = await response.json();
    const targetLink = data.pageUrl || (data.linksByPlatform?.spotify?.url || null);

    if (!targetLink) {
      return { 
        status: 404, 
        body: JSON.stringify({ error: "Sin enlaces disponibles" }) 
      };
    }

    const responseBody = JSON.stringify({ universalLink: targetLink });
    
    // Cache mejorado: 7 días para el cliente, 30 días para CDN
    const cacheResponse = new Response(responseBody, {
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=604800", // 7 días
        "CDN-Cache-Control": "max-age=2592000" // 30 días solo CDN
      }
    });

    ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
    return { status: 200, body: responseBody };

  } catch (err) {
    console.error('[Odesli] Error:', err.message);
    
    if (err.name === 'TimeoutError') {
      return { status: 504, body: JSON.stringify({ error: "Timeout obteniendo enlaces" }) };
    }
    
    return { 
      status: 500, 
      body: JSON.stringify({ error: "Error procesando solicitud" }) 
    };
  }
}

// --- HANDLER: RADIO PARADISE ---
async function handleRadioParadiseRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("url");
    
    if (!path) {
      throw new Error('MISSING_PARAMETER');
    }

    // Whitelist de paths válidos de Radio Paradise
    // Esto previene path traversal y abuse
    const VALID_RP_PATHS = /^(api\/now_playing|api\/get_block|get_block|now_playing)/;
    if (!VALID_RP_PATHS.test(path)) {
      console.warn('[Radio Paradise] Invalid path attempted:', path);
      throw new Error('INVALID_PATH');
    }

    const apiResp = await fetch(
      `https://api.radioparadise.com/${path}`,
      { signal: AbortSignal.timeout(8000) }
    );
    
    if (!apiResp.ok) {
      throw new Error('API_ERROR');
    }
    
    return { stream: apiResp.body, headers: apiResp.headers };
    
  } catch (err) {
    console.error('[Radio Paradise] Error:', err.message);
    throw err;
  }
}

// --- ORCHESTRATOR: BACKUP GITHUB ---
async function handleScheduled(event, env, ctx) {
  console.log("🤖 Orquestador de backup iniciado...");
  
  const githubApiToken = env.GITHUB_TOKEN;
  if (!githubApiToken) {
    console.error('[Scheduler] GITHUB_TOKEN no encontrado');
    return new Response("Configuración incompleta", { status: 500 });
  }

  const owner = "chicagocs";
  const repo = "radiomax";
  const workflowId = "backup.yml";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
  
  const body = { 
    ref: "main", 
    inputs: { 
      reason: `Backup automático desde Cloudflare Worker - ${new Date().toISOString()}` 
    } 
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { 
        "Authorization": `token ${githubApiToken}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "CF-Worker-Orchestrator"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000)
    });

    if (response.ok) {
      console.log('[Scheduler] Backup workflow triggered successfully');
      return new Response("Backup iniciado correctamente", { status: 200 });
    } else {
      console.error('[Scheduler] GitHub API Error:', response.status);
      return new Response(`Error al iniciar backup: ${response.status}`, { status: 500 });
    }
    
  } catch (error) {
    console.error('[Scheduler] Error:', error.message);
    return new Response(`Error de red: ${error.message}`, { status: 500 });
  }
}

// --- UTILIDADES ---
function cleanSearchTerm(term) {
  if (!term) return "";
  return term
    .replace(/[()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getAlbumTypeDescription(album) {
  const name = album.name.toLowerCase();
  const type = album.album_type;
  const reissueKeywords = [
    "remastered", "deluxe", "expanded", "anniversary", 
    "edition", "reissue", "legacy"
  ];
  
  if (type === "compilation") return "Compilación";
  if (type === "single") return "Sencillo";
  if (reissueKeywords.some((k) => name.includes(k))) return "Reedición";
  return "Álbum";
}

/**
 * Crea una respuesta de error estandarizada
 */
function createErrorResponse(status, message, headers = {}) {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        ...noCacheHeaders,
        ...headers
      }
    }
  );
}

// --- MAIN EXPORT ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Manejar preflight OPTIONS
    if (request.method === "OPTIONS") {
      // Solo permitir OPTIONS en rutas API
      if (path.startsWith("/spotify") || path.startsWith("/odesli") || path.startsWith("/radioparadise")) {
        return new Response(null, { status: 200, headers: corsHeaders });
      }
      return new Response(null, { status: 404 });
    }

    try {
      let response;

      // === RUTAS API ===
      if (path.startsWith("/spotify") || path.startsWith("/odesli") || path.startsWith("/radioparadise")) {
        
        // Validar origen
        if (!validateOrigin(request)) {
          console.warn('[Security] Invalid origin blocked:', request.headers.get("Origin"));
          return createErrorResponse(403, "Acceso denegado");
        }

        // Rate limiting
        const clientIP = request.headers.get("CF-Connecting-IP");
        if (!clientIP) {
          console.error('[Rate Limit] No client IP detected - possible proxy bypass attempt');
          // En desarrollo esto puede ocurrir con wrangler dev
          // En producción, Cloudflare siempre provee CF-Connecting-IP
        } else {
          try {
            await checkRateLimit(env, clientIP);
          } catch (err) {
            if (err.message === 'RATE_LIMIT_EXCEEDED') {
              console.warn('[Rate Limit] IP blocked:', clientIP);
              return createErrorResponse(429, "Demasiadas solicitudes. Intenta más tarde.");
            }
          }
        }

        // Enrutar a handlers específicos
        if (path.startsWith("/spotify")) {
          const result = await handleSpotifyRequest(request, env, ctx);
          response = new Response(result.body, { 
            status: result.status, 
            headers: { 
              ...corsHeaders, 
              ...noCacheHeaders, 
              "Content-Type": "application/json" 
            } 
          });
          
        } else if (path.startsWith("/odesli")) {
          const result = await handleOdesliProxyRequest(request, env, ctx);
          response = new Response(result.body, { 
            status: result.status, 
            headers: { 
              ...corsHeaders, 
              ...noCacheHeaders, 
              "Content-Type": "application/json" 
            } 
          });
          
        } else if (path.startsWith("/radioparadise")) {
          const result = await handleRadioParadiseRequest(request);
          // Copiar headers originales y agregar CORS
          const finalHeaders = new Headers(result.headers);
          Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
          // NO aplicar security headers a radioparadise (es un stream)
          return new Response(result.stream, { 
            headers: finalHeaders 
          });
        }

        // Aplicar security headers a respuestas API (excepto radioparadise)
        const finalHeaders = new Headers(response.headers);
        Object.entries(securityHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        
        return new Response(response.body, { 
          status: response.status, 
          headers: finalHeaders 
        });
      } 
      
      // === RUTAS DE ASSETS ===
      else {
        if (!env.ASSETS) {
          return new Response("Not Found", { status: 404 });
        }

        try {
          response = await env.ASSETS.fetch(request);
        } catch (err) {
          console.log('[Assets] File not found:', path);
          
          // Solo servir index.html si:
          // 1. Es un request de navegador (Accept: text/html)
          // 2. El path está en la whitelist O empieza con /assets/
          const acceptHeader = request.headers.get("Accept") || "";
          const isHtmlRequest = acceptHeader.includes("text/html");
          const isSafePath = SAFE_ASSET_PATHS.includes(path) || path.startsWith('/assets/');
          
          if (isHtmlRequest && (isSafePath || path === '/')) {
            try {
              response = await env.ASSETS.fetch(new Request("/index.html", request));
            } catch {
              response = new Response("Not Found", { status: 404 });
            }
          } else {
            response = new Response("Not Found", { status: 404 });
          }
        }

        return response;
      }

    } catch (err) {
      console.error('[Worker] Unhandled error:', err.message, err.stack);
      return createErrorResponse(500, "Error interno del servidor");
    }
  },

  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  }
};
