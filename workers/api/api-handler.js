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

// --- ODESLI PROXY (RUTA CRÍTICA) ---
async function handleOdesliProxyRequest(request) {
  console.log("HANDLER: Llamada recibida en /odesli");
  try {
    const url = new URL(request.url);
    const spotifyUrl = url.searchParams.get("url");

    if (!spotifyUrl || spotifyUrl === "NO_URL") {
      return new Response(JSON.stringify({ error: "URL de Spotify inválida" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    console.log("HANDLER: Consultando Odesli con URL: ", spotifyUrl);
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}&userCountry=AR`;
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' };

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
        console.log("HANDLER: Error Odesli ", response.status);
        return new Response(JSON.stringify({ error: `Error Odesli: ${response.status}` }), { status: response.status, headers: { "Content-Type": "application/json" } });
    }

    const data = await response.json();
    console.log("HANDLER: Odesli OK, link: ", data.pageUrl);

    if (data && data.pageUrl) {
        return new Response(JSON.stringify({ universalLink: data.pageUrl }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "No se encontraron enlaces" }), { status: 404, headers: { "Content-Type": "application/json" } });

  } catch (e) {
    console.log("HANDLER: Excepcion ", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
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
