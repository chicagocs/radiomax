// ==========================================================================
// WORKER PRINCIPAL: core >> index.js (OPTIMIZADO + SEGURO + PWA FIX)
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
  // FIX: Añadido dominio propio a connect-src y relajado img-src/font-src para PWA
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://core.chcs.workers.dev https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://radiomax.tramax.com.ar https://core.chcs.workers.dev https://api.radioparadise.com https://api.somafm.com https://musicbrainz.org https://*.supabase.co; font-src 'self' data:; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
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
  
  spotifyTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000 
  };
  
  return spotifyTokenCache.token;
}

async function checkRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return;

  const key = `ratelimit:${ip}`;
  const limit = 100; 
  
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
  }
}

// FIX ANDROID PWA: Valida origen permitiendo peticiones internas sin headers
function validateOrigin(request) {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  
  if (origin) {
    return origin === ALLOWED_ORIGIN;
  }
  
  if (referer) {
    return referer.startsWith(ALLOWED_ORIGIN);
  }
  
  // Si no hay Origin ni Referer, verificamos el Host
  const host = request.headers.get("Host");
  const allowedHost = ALLOWED_ORIGIN.replace(/^https?:\/\//, '');
  
  if (host === allowedHost) {
    return true; 
  }

  return false;
}

// --- HANDLER: SPOTIFY ---
async function handleSpotifyRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));
    const includeGenres = url.searchParams.get("includeGenres") === "true";

    if (!artist || !title) {
      return { status: 400, body: JSON.stringify({ error: 'Faltan parámetros requeridos' }) };
    }

    if (artist.length > 200 || title.length > 200 || (album && album.length > 200)) {
      return { status: 400, body: JSON.stringify({ error: 'Parámetros demasiado largos' }) };
    }

    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
      return { status: 500, body: JSON.stringify({ error: "Servicio no disponible" }) };
    }

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
          signal: AbortSignal.timeout(5000)
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
      throw new Error("SEARCH_ERROR");
    }

    if (searchData && searchData.tracks.items.length > 0) {
      const track = searchData.tracks.items[0];
      const albumData = track.album;
      const spotifyUrl = track.external_urls?.spotify || "NO_URL";
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

// --- HANDLER: ODESLI ---
async function handleOdesliProxyRequest(request, env, ctx) {
  const url = new URL(request.url);
  const spotifyUrl = url.searchParams.get("url");
  
  if (!spotifyUrl || spotifyUrl === "NO_URL") {
    return { 
      status: 400, 
      body: JSON.stringify({ error: "URL inválida" }) 
    };
  }

  if (!spotifyUrl.startsWith('https://open.spotify.com/')) {
    return { 
      status: 400, 
      body: JSON.stringify({ error: "Solo URLs de Spotify permitidas" }) 
    };
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url);

  try {
    let cached = await cache.match(cacheKey);
    if (cached) {
      return { status: 200, body: await cached.text() };
    }

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
    
    const cacheResponse = new Response(responseBody, {
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=604800",
        "CDN-Cache-Control": "max-age=2592000"
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

    const VALID_RP_PATHS = /^(api\/now_playing|api\/get_block|get_block|now_playing)/;
    if (!VALID_RP_PATHS.test(path)) {
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
      return new Response("Backup iniciado correctamente", { status: 200 });
    } else {
      return new Response(`Error al iniciar backup: ${response.status}`, { status: 500 });
    }
    
  } catch (error) {
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

    if (request.method === "OPTIONS") {
      if (path.startsWith("/spotify") || path.startsWith("/odesli") || path.startsWith("/radioparadise")) {
        return new Response(null, { status: 200, headers: corsHeaders });
      }
      return new Response(null, { status: 404 });
    }

    try {
      let response;

      if (path.startsWith("/spotify") || path.startsWith("/odesli") || path.startsWith("/radioparadise")) {
        
        if (!validateOrigin(request)) {
          console.warn('[Security] Invalid origin blocked:', request.headers.get("Origin"));
          return createErrorResponse(403, "Acceso denegado");
        }

        const clientIP = request.headers.get("CF-Connecting-IP");
        if (clientIP) {
          try {
            await checkRateLimit(env, clientIP);
          } catch (err) {
            if (err.message === 'RATE_LIMIT_EXCEEDED') {
              return createErrorResponse(429, "Demasiadas solicitudes. Intenta más tarde.");
            }
          }
        }

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
          const finalHeaders = new Headers(result.headers);
          Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
          return new Response(result.stream, { 
            headers: finalHeaders 
          });
        }

        const finalHeaders = new Headers(response.headers);
        Object.entries(securityHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        
        return new Response(response.body, { 
          status: response.status, 
          headers: finalHeaders 
        });
      } 
      
      else {
        if (!env.ASSETS) {
          return new Response("Not Found", { status: 404 });
        }

        try {
          response = await env.ASSETS.fetch(request);
        } catch (err) {
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
