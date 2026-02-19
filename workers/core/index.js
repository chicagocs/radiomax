// ==========================================================================
// WORKER PRINCIPAL: core >> index.js
// Incluye: API Completa (Spotify, Odesli, RP) + Router + Orquestador (Backup)
// Versión: FINAL CORREGIDA (Manejo de Status Correcto)
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

const securityHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), encrypted-media=(), fullscreen=(self), picture-in-picture=(self), interest-cohort=(), sync-xhr=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://i.scdn.co; connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://*.supabase.co; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

// --- UTILIDADES ---
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

// --- HANDLER: SPOTIFY ---
async function handleSpotifyRequest(request,env,ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));

    if (!artist || !title) {
      return { status: 400, body: JSON.stringify({ error: 'Faltan parámetros.' }) };
    }

    const clientId = env.SPOTIFY_CLIENT_ID;
    const clientSecret = env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return { status: 500, body: JSON.stringify({ error: "Credenciales Spotify no configuradas" }) };
    }

    const authString = btoa(`${clientId}:${clientSecret}`);
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: `Basic ${authString}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials"
    });

    if (!tokenResponse.ok) throw new Error("Error token Spotify");
    const accessToken = (await tokenResponse.json()).access_token;

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

      let trackIsrc = null;
      if (track.id) {
          try {
              const trackResponse = await fetch(`https://api.spotify.com/v1/tracks/${track.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
              if (trackResponse.ok) {
                  const fullTrack = await trackResponse.json();
                  trackIsrc = fullTrack.external_ids?.isrc || null;
              }
          } catch (e) {}
      }

      const resp = {
        imageUrl: albumData.images?.[0]?.url ?? null,
        release_date: albumData.release_date ?? null,
        label: albumData.label ?? null,
        genres: [],
        duration: Math.floor(track.duration_ms / 1e3),
        totalTracks: albumData.total_tracks ?? null,
        totalAlbumDuration: 0,
        trackNumber: null,
        albumTypeDescription: getAlbumTypeDescription(albumData),
        isrc: trackIsrc,
        links: null,
        debugSpotifyUrl: spotifyUrl
      };

      if (albumData.id) {
        try {
          const full = await fetch(`https://api.spotify.com/v1/albums/${albumData.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (full.ok) {
            const fullAlbum = await full.json();
            resp.label = fullAlbum.label ?? resp.label;
            if (fullAlbum.tracks?.items) {
              resp.totalAlbumDuration = fullAlbum.tracks.items.reduce((sum, t) => sum + t.duration_ms, 0);
              const idx = fullAlbum.tracks.items.findIndex((t) => t.id === track.id);
              if (idx !== -1) resp.trackNumber = idx + 1;
            }
          }
        } catch {}
      }

      if (track.artists.length > 0) {
        const tasks = track.artists.slice(0, 3).map(async (a) => {
          try {
            const r = await fetch(`https://api.spotify.com/v1/artists/${a.id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
            return r.ok ? (await r.json()).genres ?? [] : [];
          } catch { return []; }
        });
        resp.genres = [...new Set((await Promise.all(tasks)).flat())];
      }

      return { status: 200, body: JSON.stringify(resp) };
    }
    
    // Si no encontramos el track, devolvemos 404 (No 500)
    return { status: 404, body: JSON.stringify({ error: "Track no encontrado en Spotify" }) };
    
  } catch (err) {
    // Si es un error de red real o token, lanzamos el error para que el catch global maneje el 500
    throw err;
  }
}

// --- HANDLER: ODESLI (FIX: Recibe ctx) ---
async function handleOdesliProxyRequest(request, env, ctx) {
  const url = new URL(request.url);
  const spotifyUrl = url.searchParams.get("url");
  if (!spotifyUrl || spotifyUrl === "NO_URL") {
    return { status: 400, body: JSON.stringify({ error: "URL inválida en Odesli" }) };
  }

  // --- SISTEMA DE CACHÉ ---
  const cache = caches.default;
  const cacheKey = new Request(request.url);

  try {
    // 1. Intentar buscar en CACHÉ
    let cached = await cache.match(cacheKey);
    if (cached) {
      console.log("[Odesli] Cache HIT (Cargado de memoria)");
      return { status: 200, body: await cached.text() };
    }

    // 2. Si no está en caché, llamar a Odesli
    console.log("[Odesli] Cache MISS (Consultando API)");
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://song.link/' 
    };

    const response = await fetch(apiUrl, { headers });

    // 3. Manejo de errores
    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
         return { status: 429, body: JSON.stringify({ error: "API Odesli Saturada (429). Espera unos minutos." }) };
      }
      return { status: status, body: JSON.stringify({ error: `Error API Odesli: ${status}` }) };
    }

    const data = await response.json();
    const targetLink = data.pageUrl || (data.linksByPlatform?.spotify?.url || null);

    if (!targetLink) {
      return { status: 404, body: JSON.stringify({ error: "No se encontraron enlaces en respuesta Odesli" }) };
    }

    // 4. Guardar en CACHÉ (Ahora funciona porque tenemos ctx)
    const responseBody = JSON.stringify({ universalLink: targetLink });
    const cacheResponse = new Response(responseBody, {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=2592000" // 30 días
        }
    });

    // CRÍTICO: ctx.waitUntil necesita ctx para existir
    ctx.waitUntil(cache.put(cacheKey, cacheResponse));

    console.log("[Odesli] Enlace obtenido y guardado en caché");
    return { status: 200, body: responseBody };

  } catch (e) {
    console.error("[Odesli] Excepción:", e);
    // Si el error es "ctx is not defined", esto lo captura y lanza 500
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
  } catch (err) {
    throw err;
  }
}

// --- ORCHESTRATOR (Lógica de Backup) ---
async function handleScheduled(event, env, ctx) {
  console.log("🤖 Iniciando orquestador (evento programado/cron)...");
  const githubApiToken = env.GITHUB_TOKEN;
  if (!githubApiToken) {
    console.error("❌ ERROR CRÍTICO: La variable de entorno GITHUB_TOKEN no está configurada.");
    return new Response("Error de configuración: GITHUB_TOKEN no encontrado.", { status: 500 });
  }
  if (!githubApiToken.startsWith("ghp_") && !githubApiToken.startsWith("gho_")) {
    console.error("⚠️ ADVERTENCIA: El token de GitHub no parece tener el formato estándar.");
  }
  console.log("✅ Token de GitHub validado correctamente.");

  const owner = "chicagocs";
  const repo = "radiomax";
  const workflowId = "backup.yml";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;
  const body = {
    ref: "main",
    inputs: { reason: `Scheduled backup from Cloudflare Worker at ${new Date().toISOString()}` }
  };

  try {
    console.log("🚀 Enviando petición a la API de GitHub...");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `token ${githubApiToken}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Cloudflare-Worker-Orchestrator"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      console.log("✅ Workflow de GitHub dispatch exitoso.");
      return new Response("Backup ejecutado con éxito.", { status: 200 });
    } else {
      const errorBody = await response.text();
      console.error(`❌ Fallo al hacer dispatch del workflow. Status: ${response.status}`);
      return new Response(`Error al ejecutar backup: ${response.status}`, { status: 500 });
    }
  } catch (error) {
    console.error("🚨 ERROR DE RED O EJECUCIÓN:", error.message);
    return new Response(`Error de red al ejecutar backup: ${error.message}`, { status: 500 });
  }
}

// --- MAIN EXPORT ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      let response;

      // RUTAS DE API
      if (path.startsWith("/spotify")) {
        const result = await handleSpotifyRequest(request, env);
        response = new Response(result.body, { 
            status: result.status, 
            headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
        });
      } else if (path.startsWith("/odesli")) {
        const result = await handleOdesliProxyRequest(request, env, ctx);
        response = new Response(result.body, { 
            status: result.status, 
            headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
        });
      } else if (path.startsWith("/radioparadise")) {
        const result = await handleRadioParadiseRequest(request);
        response = new Response(result.stream, { headers: result.headers });
      } 
      // RUTAS DE ASSETS ESTÁTICOS (Sitio Web)
      else {
        if (env.ASSETS) {
          try { 
            response = await env.ASSETS.fetch(request); 
          } catch (err) { 
            console.log(`Asset not found for ${path}, serving index.html fallback.`);
            response = await env.ASSETS.fetch(new Request("/index.html", request)); 
          }
        } else {
          response = new Response("Not Found", { status: 404 });
        }
      }

      // APLICAR SECURITY HEADERS (Solo para peticiones API)
      if (path.startsWith("/spotify") || path.startsWith("/odesli") || path.startsWith("/radioparadise")) {
        const finalHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        Object.entries(noCacheHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        Object.entries(securityHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        return new Response(response.body, { status: response.status, headers: finalHeaders });
      }

      return response;

    } catch (err) {
      // MANEJO DE ERRORES GLOBAL (Solo llega aquí si hay fallo de red o servidor)
      return new Response(JSON.stringify({ 
        error: "Error interno del Worker", 
        message: err.message,
        path: path 
      }), { 
        status: 500, 
        headers: { 
          ...corsHeaders, 
          "Content-Type": "application/json",
          ...noCacheHeaders
        } 
      });
    }
  },

  async scheduled(event, env, ctx) {
    console.log("⏰ Backup disparado por el CRON programado.");
    return handleScheduled(event, env, ctx);
  }
};
