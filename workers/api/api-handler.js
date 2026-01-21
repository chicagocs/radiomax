// ==========================================================================
// api-handler.js (VERSIÓN DEFINITIVA: FULL + PROTECCIÓN CORS GLOBAL)
// ==========================================================================

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
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

// ==========================================================================
// UTILIDADES
// ==========================================================================
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

// ==========================================================================
// HANDLER: SPOTIFY (LÓGICA COMPLETA RESTAURADA)
// ==========================================================================
async function handleSpotifyRequest(request, env) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));

    if (!artist || !title) {
      throw new Error('Faltan parámetros.');
    }

    const clientId = env.SPOTIFY_CLIENT_ID;
    const clientSecret = env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Credenciales no configuradas");
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

      return JSON.stringify(resp);
    }

    // Si no se encuentra track, devolvemos estructura vacía o error
    throw new Error("Track no encontrado en Spotify");

  } catch (err) {
    // Lanzamos el error para que el catch global lo maneje con JSON correcto
    throw err; 
  }
}

// ==========================================================================
// HANDLER: ODESLI (PROXY)
// ==========================================================================
async function handleOdesliProxyRequest(request) {
  try {
    const url = new URL(request.url);
    const spotifyUrl = url.searchParams.get("url");

    if (!spotifyUrl || spotifyUrl === "NO_URL") {
      throw new Error("URL inválida en Odesli");
    }

    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://song.link/' 
    };

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Odesli Error ${response.status}: ${text}`);
    }

    const data = await response.json();
    
    let targetLink = data.pageUrl || (data.linksByPlatform?.spotify?.url || null);

    if (!targetLink) {
      throw new Error("No se encontraron enlaces en respuesta Odesli");
    }

    return JSON.stringify({ universalLink: targetLink });

  } catch (e) {
    throw e;
  }
}

// ==========================================================================
// HANDLER: RADIO PARADISE
// ==========================================================================
async function handleRadioParadiseRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("url");
    if (!path) throw new Error('Falta url en RP Proxy');

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const apiResp = await fetch(`https://api.radioparadise.com/${path}`, { signal: controller.signal });
    // Devolvemos el stream directamente para que sea rápido
    return { stream: apiResp.body, headers: apiResp.headers };
  } catch (err) {
    throw err;
  }
}

// ==========================================================================
// MAIN EXPORT (ESCUDO GLOBAL DE CRASH)
// ==========================================================================
export default {
  async fetch(request, env, ctx) {
    console.log(`[Worker Main] ${request.method} ${request.url}`);

    // -------------------------------------------------------
    // 1. CORS PREFLIGHT
    // -------------------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      let response;

      // -------------------------------------------------------
      // 2. RUTAS
      // -------------------------------------------------------
      if (url.pathname.startsWith("/spotify")) {
        const body = await handleSpotifyRequest(request, env);
        response = new Response(body, { headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } });
      } 
      else if (url.pathname.startsWith("/odesli")) {
        const body = await handleOdesliProxyRequest(request);
        response = new Response(body, { headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } });
      } 
      else if (url.pathname.startsWith("/radioparadise")) {
        const result = await handleRadioParadiseRequest(request);
        response = new Response(result.stream, { headers: result.headers }); // RP tiene sus propios headers
      } 
      else {
        // -------------------------------------------------------
        // 3. ASSETS ESTÁTICOS
        // -------------------------------------------------------
        if (env.ASSETS) {
          try { response = await env.ASSETS.fetch(request); }
          catch (err) { response = await env.ASSETS.fetch(new Request("/index.html", request)); }
        } else {
          response = new Response("<h1>Worker OK</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
        }
      }

      // -------------------------------------------------------
      // 4. APLICAR HEADERS DE SEGURIDAD (Solo si no es assets directo)
      // -------------------------------------------------------
      if (url.pathname.startsWith("/api") || url.pathname.startsWith("/spotify") || url.pathname.startsWith("/odesli")) {
        const finalHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        Object.entries(noCacheHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        Object.entries(securityHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        return new Response(response.body, { status: response.status, headers: finalHeaders });
      }

      return response;

    } catch (err) {
      // -------------------------------------------------------
      // 5. ATRAPADOR GLOBAL (FIN DEL "PAIN")
      // -------------------------------------------------------
      // Esto atrapa CUALQUIER error y devuelve JSON con CORS.
      console.error("[CRASH GLOBAL CAPTURADO]", err);
      
      return new Response(JSON.stringify({ 
        error: "Error interno del Worker", 
        message: err.message || "Error desconocido",
        stack: err.stack
      }), { 
        status: 500, 
        headers: { 
          ...corsHeaders, 
          "Content-Type": "application/json",
          ...noCacheHeaders
        } 
      });
    }
  }
};
