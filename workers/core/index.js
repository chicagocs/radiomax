// ==========================================================================
// WORKER PRINCIPAL: core >> index.js (OPTIMIZADO)
// ==========================================================================

// --- CONFIGURACIÓN DE HEADERS ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://radiomax.tramax.com.ar",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0"
};

// SUAVIZADO: Eliminamos 'require-corp' a menos que uses SharedArrayBuffer
const securityHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), encrypted-media=(), fullscreen=(self), picture-in-picture=(self), interest-cohort=(), sync-xhr=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://i.scdn.co; connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://*.supabase.co; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload"
};

// --- GESTIÓN DE TOKEN SPOTIFY (EN MEMORIA) ---
let spotifyTokenCache = {
  token: null,
  expiresAt: 0
};

async function getSpotifyToken(clientId, clientSecret) {
  // Si el token es válido, reutilizarlo
  if (spotifyTokenCache.token && Date.now() < spotifyTokenCache.expiresAt) {
    return spotifyTokenCache.token;
  }

  const authString = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${authString}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) throw new Error("Error obteniendo token Spotify");
  const data = await response.json();
  
  // Guardar en caché (expira 1 hora menos por seguridad)
  spotifyTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000) - 60000 
  };
  
  return spotifyTokenCache.token;
}

// --- HANDLER: SPOTIFY (OPTIMIZADO) ---
async function handleSpotifyRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));

    if (!artist || !title) {
      return { status: 400, body: JSON.stringify({ error: 'Faltan parámetros.' }) };
    }

    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
      return { status: 500, body: JSON.stringify({ error: "Credenciales Spotify no configuradas" }) };
    }

    // Reutilizar token
    const accessToken = await getSpotifyToken(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET);
    let searchData = null;
    let responseSpotify = null;

    // Intento 1: Con álbum
    if (album) {
      const q = `track:"${title}" artist:"${artist}" album:"${album}"`;
      responseSpotify = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    // Intento 2: Sin álbum
    if (!searchData || searchData.tracks.items.length === 0) {
      const q = `track:"${title}" artist:"${artist}"`;
      responseSpotify = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    // Intento 3: Búsqueda laxa
    if (!searchData || searchData.tracks.items.length === 0) {
      const q = `${artist} ${title}`;
      responseSpotify = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!responseSpotify.ok) throw new Error("Error búsqueda Spotify");

    if (searchData && searchData.tracks.items.length > 0) {
      const track = searchData.tracks.items[0];
      const albumData = track.album;
      const spotifyUrl = track.external_urls?.spotify || "NO_URL";

      // OPTIMIZACIÓN ISRC: Tomarlo directo del resultado de búsqueda si existe
      // Spotify search API incluye 'external_ids' en la respuesta
      let trackIsrc = track.external_ids?.isrc || null;

      const resp = {
        imageUrl: albumData.images?.[0]?.url ?? null,
        release_date: albumData.release_date ?? null,
        label: albumData.label ?? null,
        genres: [],
        duration: Math.floor(track.duration_ms / 1e3),
        totalTracks: albumData.total_tracks ?? null,
        totalAlbumDuration: 0,
        trackNumber: track.track_number, // Ya viene en la búsqueda
        albumTypeDescription: getAlbumTypeDescription(albumData),
        isrc: trackIsrc,
        links: null,
        debugSpotifyUrl: spotifyUrl
      };

      // Solo pedimos detalles del álbum si es necesario para Label o Duración Total
      // Esto ahorra una petición costosa en cada reproducción
      if (albumData.id && (!resp.label || resp.totalAlbumDuration === 0)) {
        try {
          const full = await fetch(`https://api.spotify.com/v1/albums/${albumData.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (full.ok) {
            const fullAlbum = await full.json();
            resp.label = fullAlbum.label ?? resp.label;
            if (fullAlbum.tracks?.items) {
              resp.totalAlbumDuration = fullAlbum.tracks.items.reduce((sum, t) => sum + t.duration_ms, 0);
            }
          }
        } catch {}
      }

      // Géneros (opcional, requiere peticiones paralelas)
      if (track.artists.length > 0) {
        const tasks = track.artists.slice(0, 2).map(async (a) => { // Limitar a 2 para velocidad
          try {
            const r = await fetch(`https://api.spotify.com/v1/artists/${a.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
            return r.ok ? (await r.json()).genres ?? [] : [];
          } catch { return []; }
        });
        resp.genres = [...new Set((await Promise.all(tasks)).flat())];
      }

      return { status: 200, body: JSON.stringify(resp) };
    }
    
    return { status: 404, body: JSON.stringify({ error: "Track no encontrado en Spotify" }) };
    
  } catch (err) {
    throw err;
  }
}

// ... (Mantén handleOdesliProxyRequest, handleRadioParadiseRequest, handleScheduled igual que antes) ...
// ... (Pega tus funciones Odesli y Backup aquí, están bien) ...

function cleanSearchTerm(term) {
  if (!term) return "";
  return term.replace(/[()\[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}

function getAlbumTypeDescription(album) {
  const name = album.name.toLowerCase();
  const type = album.album_type;
  const reissueKeywords = ["remastered", "deluxe", "expanded", "anniversary", "edition", "reissue", "legacy"];
  if (type === "compilation") return "Compilación";
  if (type === "single") return "Sencillo";
  if (reissueKeywords.some((k) => name.includes(k))) return "Reedición";
  return "Álbum";
}

// --- HANDLER: ODESLI ---
async function handleOdesliProxyRequest(request, env, ctx) {
  const url = new URL(request.url);
  const spotifyUrl = url.searchParams.get("url");
  if (!spotifyUrl || spotifyUrl === "NO_URL") {
    return { status: 400, body: JSON.stringify({ error: "URL inválida en Odesli" }) };
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url);

  try {
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

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      if (response.status === 429) return { status: 429, body: JSON.stringify({ error: "API Odesli Saturada" }) };
      return { status: response.status, body: JSON.stringify({ error: `Error Odesli: ${response.status}` }) };
    }

    const data = await response.json();
    const targetLink = data.pageUrl || (data.linksByPlatform?.spotify?.url || null);

    if (!targetLink) return { status: 404, body: JSON.stringify({ error: "Sin enlaces Odesli" }) };

    const responseBody = JSON.stringify({ universalLink: targetLink });
    const cacheResponse = new Response(responseBody, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=2592000" }
    });

    ctx.waitUntil(cache.put(cacheKey, cacheResponse));
    return { status: 200, body: responseBody };

  } catch (e) {
    throw e; 
  }
}

// --- HANDLER: RADIO PARADISE ---
async function handleRadioParadiseRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("url");
    if (!path) throw new Error('Falta url en RP Proxy');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const apiResp = await fetch(`https://api.radioparadise.com/${path}`, { signal: controller.signal });
    return { stream: apiResp.body, headers: apiResp.headers };
  } catch (err) { throw err; }
}

// --- ORCHESTRATOR ---
async function handleScheduled(event, env, ctx) {
  console.log("🤖 Orquestador iniciado...");
  const githubApiToken = env.GITHUB_TOKEN;
  if (!githubApiToken) return new Response("GITHUB_TOKEN no encontrado.", { status: 500 });

  const owner = "chicagocs";
  const repo = "radiomax";
  const workflowId = "backup.yml";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
  const body = { ref: "main", inputs: { reason: `Backup from Cloudflare Worker ${new Date().toISOString()}` } };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `token ${githubApiToken}`, "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json", "User-Agent": "CF-Worker-Orchestrator" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response.ok ? new Response("Backup OK", { status: 200 }) : new Response(`Backup Error ${response.status}`, { status: 500 });
  } catch (error) {
    return new Response(`Backup Error Red: ${error.message}`, { status: 500 });
  }
}

// --- MAIN EXPORT ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

    try {
      let response;

      // RUTAS API
      if (path.startsWith("/spotify")) {
        const result = await handleSpotifyRequest(request, env, ctx);
        response = new Response(result.body, { status: result.status, headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } });
      } else if (path.startsWith("/odesli")) {
        const result = await handleOdesliProxyRequest(request, env, ctx);
        response = new Response(result.body, { status: result.status, headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } });
      } else if (path.startsWith("/radioparadise")) {
        const result = await handleRadioParadiseRequest(request);
        response = new Response(result.stream, { headers: result.headers });
      } 
      // RUTAS DE ASSETS
      else {
        if (env.ASSETS) {
          try { 
            response = await env.ASSETS.fetch(request); 
          } catch (err) { 
            // FIX: Solo servir index.html si es una petición de navegador (HTML)
            const acceptHeader = request.headers.get("Accept") || "";
            if (acceptHeader.includes("text/html")) {
               response = await env.ASSETS.fetch(new Request("/index.html", request)); 
            } else {
               response = new Response("Asset not found", { status: 404 });
            }
          }
        } else {
          response = new Response("Not Found", { status: 404 });
        }
      }

      // Aplicar Security Headers solo a API
      if (path.startsWith("/spotify") || path.startsWith("/odesli") || path.startsWith("/radioparadise")) {
        const finalHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        Object.entries(noCacheHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        Object.entries(securityHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        return new Response(response.body, { status: response.status, headers: finalHeaders });
      }

      return response;

    } catch (err) {
      return new Response(JSON.stringify({ error: "Error interno", message: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json", ...noCacheHeaders } });
    }
  },

  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  }
};
