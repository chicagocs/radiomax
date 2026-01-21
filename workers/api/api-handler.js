// workers/api/api-handler.js
// Versión On-Demand Segura

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://radiomax.tramax.com.ar",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
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

// --- SPOTIFY HANDLER ---
async function handleSpotifyRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));
    const album = cleanSearchTerm(url.searchParams.get("album"));

    if (!artist || !title) {
      return new Response(JSON.stringify({ error: 'Faltan parámetros.' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const clientId = env.SPOTIFY_CLIENT_ID;
    const clientSecret = env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: "Credenciales no configuradas" }), { status: 500, headers: { "Content-Type": "application/json" } });
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

    if (album) {
      const q = `track:"${title}" artist:"${artist}" album:"${album}"`;
      responseSpotify = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!searchData || searchData.tracks.items.length ===0) {
      const q = `track:"${title}" artist:"${artist}"`;
      responseSpotify = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (responseSpotify.ok) searchData = await responseSpotify.json();
    }

    if (!searchData || searchData.tracks.items.length ===0) {
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

      return new Response(JSON.stringify(resp), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
        imageUrl: null, release_date: null, label: null, genres: [], duration: 0,
        totalTracks: null, totalAlbumDuration: 0, trackNumber: null, albumTypeDescription: null,
        isrc: null, links: null, debugSpotifyUrl: "NOT_FOUND"
    }), { status: 404, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Error interno Spotify", details: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// --- ODESLI PROXY (RUTA CRÍTICA MEJORADA) ---
async function handleOdesliProxyRequest(request) {
  console.log("HANDLER: Llamada recibida en /odesli");
  try {
    const url = new URL(request.url);
    const spotifyUrl = url.searchParams.get("url");

    // Validación estricta de la URL de entrada
    if (!spotifyUrl || spotifyUrl === "NO_URL" || spotifyUrl.trim() === "") {
      console.warn("HANDLER: URL inválida recibida:", spotifyUrl);
      return new Response(JSON.stringify({ error: "URL de Spotify inválida o vacía", debugInput: spotifyUrl }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }

    console.log("HANDLER: Consultando Odesli con URL: ", spotifyUrl);
    
    // Nota: userCountry=AR puede afectar la disponibilidad. Puedes cambiarlo a 'US' si sigue fallando.
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}&userCountry=AR`;
    
    // Cabeceras robustas para evitar bloqueos o respuestas en HTML
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json', // CRÍTICO: Forzar respuesta JSON
      'Accept-Language': 'en-US,en;q=0.9',
    };

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
        console.log("HANDLER: Error HTTP Odesli ", response.status);
        // Si Odesli devuelve 404, pasamos el mensaje claro
        if (response.status === 404) {
             return new Response(JSON.stringify({ error: "Canción no encontrada en Odesli (404)" }), { status: 404, headers: { "Content-Type": "application/json" } });
        }
        // Si es un error 5xx u otro, lo pasamos tal cual
        const errorText = await response.text();
        return new Response(JSON.stringify({ error: `Error Odesli: ${response.status}`, details: errorText }), { status: response.status, headers: { "Content-Type": "application/json" } });
    }

    const data = await response.json();
    console.log("HANDLER: Odesli Response Keys:", Object.keys(data));
    console.log("HANDLER: PageUrl encontrada:", data.pageUrl);

    // Prioridad 1: Usar el pageUrl universal de song.link
    if (data && data.pageUrl) {
        return new Response(JSON.stringify({ universalLink: data.pageUrl }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Prioridad 2: Si no hay pageUrl universal, intentar buscar el enlace directo de Spotify
    // Esto sucede a veces con ciertas configuraciones regionales
    if (data && data.linksByPlatform && data.linksByPlatform.spotify) {
        console.log("HANDLER: Fallback a enlace directo de Spotify");
        return new Response(JSON.stringify({ universalLink: data.linksByPlatform.spotify.url }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // Si nada funciona, devolvemos error 404 con información de depuración
    console.error("HANDLER: Estructura de respuesta inesperada:", JSON.stringify(data));
    return new Response(JSON.stringify({ error: "No se encontraron enlaces (Estructura inválida)", debugData: data }), { status: 404, headers: { "Content-Type": "application/json" } });

  } catch (e) {
    console.error("HANDLER: Excepción capturada:", e);
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// --- RADIO PARADISE HANDLER ---
async function handleRadioParadiseRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("url");
    if (!path) return new Response(JSON.stringify({ error: 'Falta url.' }), { status: 400, headers: { "Content-Type": "application/json" } });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const apiResp = await fetch(`https://api.radioparadise.com/${path}`, { signal: controller.signal });
    return new Response(apiResp.body, apiResp);
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy RP error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

// --- EXPORT ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;

    if (request.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

    // 1. Verificar rutas específicas
    if (url.pathname.startsWith("/spotify")) {
      response = await handleSpotifyRequest(request, env, ctx);
    } else if (url.pathname.startsWith("/odesli")) {
      // ESTA ES LA RUTA QUE ESTÁ FALLANDO POR NO ESTAR DESPLEGADA
      console.log("ROUTER: Redirigiendo a /odesli");
      response = await handleOdesliProxyRequest(request);
    } else if (url.pathname.startsWith("/radioparadise")) {
      response = await handleRadioParadiseRequest(request);
    } else {
      // 2. Fallback a Assets Estáticos
      if (env.ASSETS) {
        try { response = await env.ASSETS.fetch(request); }
        catch (err) { response = await env.ASSETS.fetch(new Request("/index.html", request)); }
      } else {
        response = new Response("<h1>OK</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
    }

    // 3. Aplicar Headers a cualquier respuesta
    const finalHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
    Object.entries(securityHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
       
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: finalHeaders });
  }
};
