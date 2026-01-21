// workers/api/api-handler.js
// caché Server-Side integrada + Request Coalescing (Anti-429)

// ===============================================================
//  CONFIGURACIÓN DE ENCABEZADOS
// ===============================================================

// Encabezados CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://radiomax.tramax.com.ar",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

// Encabezados de seguridad
const securityHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  
  "Permissions-Policy":
    "geolocation=(), microphone=(), camera=(), payment=(), usb=(), " +
    "magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), " +
    "encrypted-media=(), fullscreen=(self), picture-in-picture=(self), " +
    "interest-cohort=(), sync-xhr=()",
  
  "Content-Security-Policy":
    "default-src 'none'; " +
    "script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; " + 
    "worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; " + 
    "img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://i.scdn.co; " + 
    "connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://*.supabase.co; " +
    "font-src 'self'; " +
    "manifest-src 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    "upgrade-insecure-requests",
  
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

// ===============================================================
//  UTILIDADES
// ===============================================================
function cleanSearchTerm(term) {
  if (!term) return "";
  return term.replace(/[()\[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}

function getAlbumTypeDescription(album) {
  const name = album.name.toLowerCase();
  const type = album.album_type;

  const reissueKeywords = [
    "remastered",
    "deluxe",
    "expanded",
    "anniversary",
    "edition",
    "reissue",
    "legacy"
  ];

  if (type === "compilation") return "Compilación";
  if (type === "single") return "Sencillo";
  if (reissueKeywords.some((k) => name.includes(k))) return "Reedición";

  return "Álbum";
}

// ===============================================================
//  ODESLI / SONGLINK HANDLER
// ===============================================================
/**
 * Obtiene los enlaces universales.
 * Devuelve un objeto con { success: bool, data: ..., error: ... }
 */
async function getOdesliLinks(spotifyUrl) {
  try {
    // Endpoint público de Odesli v1-alpha.1
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}&userCountry=AR`;
    
    // Agregamos User-Agent para simular un navegador real
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    };

    const response = await fetch(apiUrl, { headers });
    
    // Si la respuesta HTTP no es OK (ej: 404, 500, 429)
    if (!response.ok) {
      return { 
        success: false, 
        status: response.status, 
        error: `HTTP Error ${response.status}` 
      };
    }

    const data = await response.json();
    
    // Si la API no devuelve pageUrl
    if (!data || !data.pageUrl) {
      return { success: false, error: "Odesli found no pageUrl in response" };
    }
    
    return { success: true, data: data };

  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===============================================================
//  GESTIÓN DE COALESCING (Anti-429)
// ===============================================================
// Mapa global para almacenar peticiones en curso.
const pendingOdesliRequests = new Map();

// ===============================================================
//  SPOTIFY HANDLER
// ===============================================================
async function handleSpotifyRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));

    if (!artist || !title) {
      return new Response(
        JSON.stringify({ error: 'Faltan los parámetros "artist" y "title".' }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const clientId = env.SPOTIFY_CLIENT_ID;
    const clientSecret = env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ error: "Credenciales de Spotify no configuradas" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const authString = btoa(`${clientId}:${clientSecret}`);
    const tokenResponse = await fetch(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authString}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
      }
    );

    if (!tokenResponse.ok) throw new Error("No se pudo obtener token de Spotify");
    const accessToken = (await tokenResponse.json()).access_token;

    let searchData = null;
    let responseSpotify = null;

    // Estrategia de búsqueda: Con album -> Exacta -> Suave
    if (album) {
      const q = `track:"${title}" artist:"${artist}" album:"${album}"`;
      responseSpotify = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!searchData || searchData.tracks.items.length === 0) {
      const q = `track:"${title}" artist:"${artist}"`;
      responseSpotify = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!searchData || searchData.tracks.items.length === 0) {
      const q = `${artist} ${title}`;
      responseSpotify = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!responseSpotify.ok) throw new Error("Error en búsqueda de Spotify");

    if (searchData && searchData.tracks.items.length > 0) {
      const track = searchData.tracks.items[0];
      const albumData = track.album;
      
      const spotifyUrl = track.external_urls?.spotify || "NO_URL";
      
      // =================================================================
      // CACHÉ KV + COALESCING (Optimización Anti-429)
      // =================================================================
      const cacheKey = `odesli_cache:${spotifyUrl}`;
      let odesliResult;

      try {
          const cachedData = await env.AREA51_KV.get(cacheKey, { type: 'json' });
          
          if (cachedData) {
              if (cachedData._cachedError) {
                  // Negative Cache Hit
                  odesliResult = { 
                      success: false, 
                      error: cachedData.error, 
                      status: cachedData.status,
                      isCachedError: true 
                  };
              } else {
                  // Positive Cache Hit
                  odesliResult = { success: true, data: cachedData };
              }
          } else {
              // Cache Miss
              if (pendingOdesliRequests.has(cacheKey)) {
                  // Reutilizar petición en curso (Coalescing)
                  odesliResult = await pendingOdesliRequests.get(cacheKey);
              } else {
                  // Nueva petición externa
                  const fetchPromise = (async () => {
                      try {
                          const result = await getOdesliLinks(spotifyUrl);

                          if (result.success) {
                              // Guardar en KV (30 días)
                              ctx.waitUntil(
                                  env.AREA51_KV.put(cacheKey, JSON.stringify(result.data), {
                                      expirationTtl: 2592000 
                                  })
                              );
                          } else {
                              // Negative Caching si es error de servidor o límite de tasa (15 min)
                              if (result.status === 429 || result.status >= 500) {
                                  ctx.waitUntil(
                                      env.AREA51_KV.put(cacheKey, JSON.stringify({
                                          _cachedError: true,
                                          error: result.error,
                                          status: result.status
                                      }), {
                                          expirationTtl: 900 
                                      })
                                  );
                              }
                          }
                          return result;
                      } catch (e) {
                           return { success: false, error: e.message };
                      } finally {
                          pendingOdesliRequests.delete(cacheKey);
                      }
                  })();

                  pendingOdesliRequests.set(cacheKey, fetchPromise);
                  odesliResult = await fetchPromise;
              }
          }
      } catch (kvError) {
          console.error(`[KV Cache] Error: ${kvError.message}. Continuando sin caché.`);
          // Fallback simple si falla KV
          odesliResult = await getOdesliLinks(spotifyUrl);
      }
      // =================================================================

      let trackIsrc = null;
      if (track.id) {
          try {
              const trackResponse = await fetch(
                  `https://api.spotify.com/v1/tracks/${track.id}`,
                  { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (trackResponse.ok) {
                  const fullTrack = await trackResponse.json();
                  trackIsrc = fullTrack.external_ids?.isrc || null;
              }
          } catch (e) {
              console.error("Error obteniendo ISRC:", e);
          }
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
        debugSpotifyUrl: spotifyUrl,
        odesliError: null
      };

      // Obtener detalles adicionales del álbum
      if (albumData.id) {
        try {
          const full = await fetch(
            `https://api.spotify.com/v1/albums/${albumData.id}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (full.ok) {
            const fullAlbum = await full.json();
            resp.label = fullAlbum.label ?? resp.label;
            if (fullAlbum.tracks?.items) {
              resp.totalAlbumDuration = fullAlbum.tracks.items.reduce(
                (sum, t) => sum + t.duration_ms,
                0
              );
              const idx = fullAlbum.tracks.items.findIndex(
                (t) => t.id === track.id
              );
              if (idx !== -1) resp.trackNumber = idx + 1;
            }
          }
        } catch {
        }
      }

      // Obtener géneros de los artistas
      if (track.artists.length > 0) {
        const tasks = track.artists.slice(0, 3).map(async (a) => {
          try {
            const r = await fetch(
              `https://api.spotify.com/v1/artists/${a.id}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            return r.ok ? (await r.json()).genres ?? [] : [];
          } catch {
            return [];
          }
        });
        resp.genres = [...new Set((await Promise.all(tasks)).flat())];
      }

      // Asignar enlaces Odesli
      if (odesliResult.success) {
        resp.links = {
          universalLink: odesliResult.data.pageUrl,
          platforms: odesliResult.data.linksByPlatform || {}
        };
        resp.odesliError = null;
      } else {
        resp.links = null;
        resp.odesliError = odesliResult.error;
        if (!odesliResult.isCachedError) {
            console.error(`Odesli API failed for ${spotifyUrl}:`, odesliResult.error);
        }
      }

      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify({
        imageUrl: null,
        release_date: null,
        label: null,
        genres: [],
        duration: 0,
        totalTracks: null,
        totalAlbumDuration: 0,
        trackNumber: null,
        albumTypeDescription: null,
        isrc: null,
        links: null,
        debugSpotifyUrl: "NOT_FOUND",
        odesliError: "Track not found in Spotify"
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" }
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Error interno Spotify", details: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ===============================================================
//  RADIO PARADISE HANDLER
// ===============================================================
async function handleRadioParadiseRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("url");

    if (!path) {
      return new Response(
        JSON.stringify({ error: 'Se requiere "url".' }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const targetUrl = `https://api.radioparadise.com/${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const apiResp = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeout);

    return new Response(apiResp.body, apiResp);

  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Proxy RP error", details: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ===============================================================
//  MÓDULO EXPORTADO
// ===============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    if (url.pathname.startsWith("/spotify")) {
      response = await handleSpotifyRequest(request, env, ctx);
    } else if (url.pathname.startsWith("/radioparadise")) {
      response = await handleRadioParadiseRequest(request);
    } else {
      if (env.ASSETS) {
        try {
          response = await env.ASSETS.fetch(request);
        } catch (err) {
          response = await env.ASSETS.fetch(new Request("/index.html", request));
        }
      } else {
        response = new Response("<h1>OK</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
    }

    const finalHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
    Object.entries(securityHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
       
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: finalHeaders
    });
  }
};
