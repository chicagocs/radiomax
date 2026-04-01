// workers/core/index.js
// Metadata chain: iTunes (primario) → Last.fm (fallback imagen/fecha) → MusicBrainz (créditos/ISRC)
// Spotify removido — cambió condiciones para Developers

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

var corsHeaders = {
  "Access-Control-Allow-Origin": "https://radiomax.tramax.com.ar",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

var noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0"
};

var securityHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), encrypted-media=(), fullscreen=(self), picture-in-picture=(self), interest-cohort=(), sync-xhr=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://is5-ssl.mzstatic.com https://lastfm.freetls.fastly.net; connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://itunes.apple.com https://ws.audioscrobbler.com; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

// ==========================================================================
// UTILIDADES
// ==========================================================================
function cleanSearchTerm(term) {
  if (!term) return "";
  return term.replace(/[()\[\]{}]/g, " ").replace(/\s+/g, " ").trim();
}
__name(cleanSearchTerm, "cleanSearchTerm");

function msToSeconds(ms) {
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}
__name(msToSeconds, "msToSeconds");

// ==========================================================================
// ITUNES SEARCH
// ==========================================================================
async function fetchITunes(artist, title, album) {
  // Intento 1: artista + título + álbum
  const queries = [];
  if (album) {
    queries.push(`${artist} ${title} ${album}`);
  }
  queries.push(`${artist} ${title}`);
  queries.push(title);

  for (const q of queries) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=10&country=US`;
      const res = await fetch(url, {
        headers: { "User-Agent": "RadioMax/1.0" }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.results || data.results.length === 0) continue;

      // Buscar el resultado que mejor matchee artista y título
      const aLow = artist.toLowerCase();
      const tLow = title.toLowerCase();
      let best = null;

      for (const r of data.results) {
        const rArtist = (r.artistName || "").toLowerCase();
        const rTitle = (r.trackName || "").toLowerCase();
        if (rArtist.includes(aLow) || aLow.includes(rArtist)) {
          if (rTitle.includes(tLow) || tLow.includes(rTitle)) {
            best = r;
            break;
          }
        }
      }

      // Fallback: primer resultado
      if (!best) best = data.results[0];
      if (best) return best;
    } catch (e) {
      continue;
    }
  }
  return null;
}
__name(fetchITunes, "fetchITunes");

// Obtener colección completa del álbum en iTunes para totalAlbumDuration y totalTracks reales
async function fetchITunesAlbum(collectionId) {
  if (!collectionId) return null;
  try {
    const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=song&limit=200`;
    const res = await fetch(url, {
      headers: { "User-Agent": "RadioMax/1.0" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || data.results.length < 2) return null;
    // El primer resultado es el álbum, el resto son tracks
    const tracks = data.results.filter(r => r.wrapperType === "track");
    const albumInfo = data.results.find(r => r.wrapperType === "collection");
    return { tracks, albumInfo };
  } catch (e) {
    return null;
  }
}
__name(fetchITunesAlbum, "fetchITunesAlbum");

function getAlbumTypeFromITunes(track) {
  // iTunes no expone album_type directamente, inferimos del collectionName
  const name = (track.collectionName || "").toLowerCase();
  const reissueKeywords = ["remastered", "deluxe", "expanded", "anniversary", "edition", "reissue", "legacy"];
  if (track.collectionArtistName && track.collectionArtistName.toLowerCase() === "various artists") {
    return "Compilación";
  }
  if (reissueKeywords.some(k => name.includes(k))) return "Reedición";
  // Single: trackCount muy bajo o "- single" en el nombre del álbum
  if (name.includes("- single") || (track.trackCount && track.trackCount === 1)) return "Sencillo";
  return "Álbum";
}
__name(getAlbumTypeFromITunes, "getAlbumTypeFromITunes");

// ==========================================================================
// LAST.FM
// ==========================================================================
async function fetchLastFm(artist, title, apiKey) {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&autocorrect=1&format=json`;
    const res = await fetch(url, {
      headers: { "User-Agent": "RadioMax/1.0" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error || !data.track) return null;
    return data.track;
  } catch (e) {
    return null;
  }
}
__name(fetchLastFm, "fetchLastFm");

function getBestImageFromLastFm(track) {
  // Last.fm devuelve array de imágenes por tamaño: small, medium, large, extralarge, mega
  const album = track.album;
  if (!album || !album.image) return null;
  const sizes = ["extralarge", "mega", "large", "medium"];
  for (const size of sizes) {
    const img = album.image.find(i => i.size === size);
    if (img && img["#text"] && img["#text"].trim() !== "") {
      return img["#text"];
    }
  }
  return null;
}
__name(getBestImageFromLastFm, "getBestImageFromLastFm");

// ==========================================================================
// MUSICBRAINZ — ISRC y créditos
// ==========================================================================
async function fetchMusicBrainzIsrc(artist, title) {
  try {
    const cleanTitle = title.replace(/\([^)]*\)/g, "").trim();
    const q = `artist:"${artist}" AND recording:"${cleanTitle}"`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=3`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RadioMax/1.0 (radiomax.tramax.com.ar)",
        "Accept": "application/json"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.recordings || data.recordings.length === 0) return null;

    const recording = data.recordings[0];
    // Intentar obtener ISRC del primer recording
    if (recording.isrcs && recording.isrcs.length > 0) {
      return recording.isrcs[0];
    }

    // Segundo intento: buscar ISRC en detalle del recording
    const recId = recording.id;
    if (!recId) return null;

    await new Promise(r => setTimeout(r, 1100)); // Respetar rate limit MusicBrainz

    const recRes = await fetch(
      `https://musicbrainz.org/ws/2/recording/${recId}?inc=isrcs&fmt=json`,
      {
        headers: {
          "User-Agent": "RadioMax/1.0 (radiomax.tramax.com.ar)",
          "Accept": "application/json"
        }
      }
    );
    if (!recRes.ok) return null;
    const recData = await recRes.json();
    return recData.isrcs?.[0] || null;
  } catch (e) {
    return null;
  }
}
__name(fetchMusicBrainzIsrc, "fetchMusicBrainzIsrc");

// ==========================================================================
// HANDLER PRINCIPAL: /spotify (mantiene misma ruta para compatibilidad con app.js)
// ==========================================================================
async function handleMetadataRequest(request, env) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist") || "");
    const title = cleanSearchTerm(url.searchParams.get("title") || "");
    const album = cleanSearchTerm(url.searchParams.get("album") || "");

    if (!artist || !title) {
      return { status: 400, body: JSON.stringify({ error: "Faltan parámetros." }) };
    }

    const lastfmApiKey = env.LASTFM_API_KEY;

    // Respuesta base con los mismos campos que antes esperaba el app.js
    const resp = {
      imageUrl: null,
      release_date: null,
      label: null,
      genres: [],
      duration: 0,
      totalTracks: null,
      totalAlbumDuration: 0,
      trackNumber: null,
      albumTypeDescription: "Álbum",
      isrc: null,
      links: null,
      debugSpotifyUrl: null   // campo mantenido por compatibilidad, ahora siempre null
    };

    // ==========================================================================
    // FUENTE 1: iTunes (primario para portada, fecha, duración, tracks, label)
    // ==========================================================================
    const iTunesTrack = await fetchITunes(artist, title, album);

    if (iTunesTrack) {
      // Portada: iTunes devuelve 100x100 por defecto, subimos a 600x600
      if (iTunesTrack.artworkUrl100) {
        resp.imageUrl = iTunesTrack.artworkUrl100
          .replace("100x100bb", "600x600bb")
          .replace("100x100", "600x600");
      }

      // Fecha de lanzamiento
      if (iTunesTrack.releaseDate) {
        resp.release_date = iTunesTrack.releaseDate.substring(0, 10); // YYYY-MM-DD
      }

      // Duración en segundos
      if (iTunesTrack.trackTimeMillis) {
        resp.duration = msToSeconds(iTunesTrack.trackTimeMillis);
      }

      // Número de track en el álbum
      if (iTunesTrack.trackNumber) {
        resp.trackNumber = iTunesTrack.trackNumber;
      }

      // Tipo de álbum
      resp.albumTypeDescription = getAlbumTypeFromITunes(iTunesTrack);

      // Géneros: iTunes solo expone primaryGenreName
      if (iTunesTrack.primaryGenreName) {
        resp.genres = [iTunesTrack.primaryGenreName];
      }

      // Total de tracks y duración total del álbum — necesita lookup del álbum
      if (iTunesTrack.collectionId) {
        const albumData = await fetchITunesAlbum(iTunesTrack.collectionId);
        if (albumData) {
          if (albumData.tracks.length > 0) {
            resp.totalTracks = albumData.tracks.length;
            resp.totalAlbumDuration = albumData.tracks.reduce(
              (sum, t) => sum + (t.trackTimeMillis || 0), 0
            );
            // totalAlbumDuration en ms — app.js lo convierte si > 10000
          }
          // label: iTunes no lo expone directamente, queda null
        } else {
          // Si no se pudo obtener el álbum completo, usar trackCount de la pista
          resp.totalTracks = iTunesTrack.trackCount || null;
        }
      } else {
        resp.totalTracks = iTunesTrack.trackCount || null;
      }
    }

    // ==========================================================================
    // FUENTE 2: Last.fm (fallback para portada si iTunes no la tiene; géneros extra)
    // ==========================================================================
    if (lastfmApiKey) {
      const lfmTrack = await fetchLastFm(artist, title, lastfmApiKey);
      if (lfmTrack) {
        // Portada: usar Last.fm solo si iTunes no trajo imagen
        if (!resp.imageUrl) {
          const lfmImg = getBestImageFromLastFm(lfmTrack);
          if (lfmImg) resp.imageUrl = lfmImg;
        }

        // Fecha: usar Last.fm solo si iTunes no la tiene
        if (!resp.release_date && lfmTrack.album?.wiki?.published) {
          // wiki.published viene como "DD Mon YYYY, HH:MM" — extraemos el año
          const match = lfmTrack.album.wiki.published.match(/\d{4}/);
          if (match) resp.release_date = match[0] + "-01-01"; // aproximación
        }

        // Géneros: Last.fm tiene tags — agregar a géneros de iTunes sin duplicar
        if (lfmTrack.toptags && lfmTrack.toptags.tag) {
          const lfmGenres = lfmTrack.toptags.tag
            .slice(0, 3)
            .map(t => t.name)
            .filter(g => g && g.length > 1 && !/^\d+$/.test(g));
          const combined = [...new Set([...resp.genres, ...lfmGenres])];
          resp.genres = combined.slice(0, 3);
        }

        // Duración: Last.fm tiene duración en ms como string
        if (!resp.duration && lfmTrack.duration) {
          const dur = parseInt(lfmTrack.duration, 10);
          if (dur > 0) resp.duration = msToSeconds(dur);
        }
      }
    }

    // ==========================================================================
    // FUENTE 3: MusicBrainz (ISRC — se ejecuta en paralelo con lo anterior)
    // ==========================================================================
    const isrc = await fetchMusicBrainzIsrc(artist, title);
    if (isrc) {
      resp.isrc = isrc.toUpperCase();
    }

    // Si no se encontró nada en ninguna fuente, devolver 404
    if (!resp.imageUrl && !resp.release_date && resp.duration === 0) {
      return {
        status: 404,
        body: JSON.stringify({ error: "Track no encontrado en ninguna fuente" })
      };
    }

    return { status: 200, body: JSON.stringify(resp) };

  } catch (err) {
    throw err;
  }
}
__name(handleMetadataRequest, "handleMetadataRequest");

// ==========================================================================
// RADIO PARADISE PROXY (sin cambios)
// ==========================================================================
async function handleRadioParadiseRequest(request) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("url");
    if (!path) throw new Error("Falta url en RP Proxy");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const apiResp = await fetch(`https://api.radioparadise.com/${path}`, {
      signal: controller.signal
    });
    return { stream: apiResp.body, headers: apiResp.headers };
  } catch (err) {
    throw err;
  }
}
__name(handleRadioParadiseRequest, "handleRadioParadiseRequest");

// ==========================================================================
// SCHEDULED (sin cambios)
// ==========================================================================
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
    inputs: {
      reason: `Scheduled backup from Cloudflare Worker at ${new Date().toISOString()}`
    }
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
__name(handleScheduled, "handleScheduled");

// ==========================================================================
// FETCH HANDLER PRINCIPAL
// ==========================================================================
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    try {
      let response;

      // /spotify mantenido como ruta para compatibilidad con app.js existente
      if (path.startsWith("/spotify")) {
        const result = await handleMetadataRequest(request, env);
        response = new Response(result.body, {
          status: result.status,
          headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" }
        });

      } else if (path.startsWith("/radioparadise")) {
        const result = await handleRadioParadiseRequest(request);
        response = new Response(result.stream, { headers: result.headers });

      } else {
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

      if (path.startsWith("/spotify") || path.startsWith("/radioparadise")) {
        const finalHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        Object.entries(noCacheHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        Object.entries(securityHeaders).forEach(([key, value]) => finalHeaders.set(key, value));
        return new Response(response.body, { status: response.status, headers: finalHeaders });
      }

      return response;

    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Error interno del Worker",
          message: err.message,
          path
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            ...noCacheHeaders
          }
        }
      );
    }
  },

  async scheduled(event, env, ctx) {
    console.log("⏰ Backup disparado por el CRON programado.");
    return handleScheduled(event, env, ctx);
  }
};

export { index_default as default };
