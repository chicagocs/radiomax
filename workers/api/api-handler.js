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
  if (reissueKeywords.some(k => name.includes(k))) return "Reedición";
  return "Álbum";
}

// ===============================================================
//  ODESLI HANDLER
// ===============================================================
async function getOdesliLinks(spotifyUrl) {
  try {
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}&userCountry=AR`;
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };

    const response = await fetch(apiUrl, { headers });

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        error: `HTTP Error ${response.status}: ${response.statusText}`
      };
    }

    const data = await response.json();
    if (!data || !data.pageUrl) {
      return { success: false, error: "Odesli found no pageUrl in response" };
    }

    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ===============================================================
//  COALESCING
// ===============================================================
const pendingOdesliRequests = new Map();

// ===============================================================
//  SPOTIFY HANDLER
// ===============================================================
async function handleSpotifyRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist"));
    const title = cleanSearchTerm(url.searchParams.get("title"));

    if (!artist || !title) {
      return new Response(JSON.stringify({ error: "Faltan parámetros" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const authString = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!tokenResp.ok) throw new Error("Token Spotify inválido");
    const { access_token } = await tokenResp.json();

    const searchResp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(
        `${artist} ${title}`
      )}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    const searchData = await searchResp.json();
    if (!searchData.tracks.items.length) {
      return new Response(JSON.stringify({ error: "Track no encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const track = searchData.tracks.items[0];
    const spotifyUrl = track.external_urls.spotify;
    const cacheKey = `odesli_cache:${spotifyUrl}`;
    let odesliResult;

    const cached = await env.AREA51_KV.get(cacheKey, { type: "json" });
    if (cached) {
      odesliResult = cached._cachedError
        ? { success: false, ...cached, isCachedError: true }
        : { success: true, data: cached };
    } else if (pendingOdesliRequests.has(cacheKey)) {
      odesliResult = await pendingOdesliRequests.get(cacheKey);
    } else {
      const fetchPromise = (async () => {
        try {
          const result = await getOdesliLinks(spotifyUrl);

          if (result.success) {
            ctx.waitUntil(
              env.AREA51_KV.put(cacheKey, JSON.stringify(result.data), {
                expirationTtl: 604800
              })
            );
          } else if (result.status === 429 || result.status >= 500) {
            const negativeTtl =
              result.status === 429 ? 900 :
              result.status >= 500 ? 300 :
              90;

            ctx.waitUntil(
              env.AREA51_KV.put(
                cacheKey,
                JSON.stringify({
                  _cachedError: true,
                  error: result.error,
                  status: result.status
                }),
                { expirationTtl: negativeTtl }
              )
            );
          }

          return result;
        } finally {
          pendingOdesliRequests.delete(cacheKey);
        }
      })();

      pendingOdesliRequests.set(cacheKey, fetchPromise);
      odesliResult = await fetchPromise;
    }

    return new Response(
      JSON.stringify({
        spotifyUrl,
        links: odesliResult.success ? odesliResult.data : null,
        odesliError: odesliResult.success ? null : odesliResult.error
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// ===============================================================
//  EXPORT
// ===============================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    let response;
    if (new URL(request.url).pathname.startsWith("/spotify")) {
      response = await handleSpotifyRequest(request, env, ctx);
    } else {
      response = new Response("OK");
    }

    const headers = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([k, v]) => headers.set(k, v));
    Object.entries(securityHeaders).forEach(([k, v]) => headers.set(k, v));

    return new Response(response.body, {
      status: response.status,
      headers
    });
  }
};
