// workers/core/index.js
// Metadata chain: iTunes (primario) → Last.fm (fallback) → MusicBrainz (ISRC) → Discogs (backup silencioso)
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
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://is5-ssl.mzstatic.com https://lastfm.freetls.fastly.net https://i.discogs.com; connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://itunes.apple.com https://ws.audioscrobbler.com https://api.discogs.com; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
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
// FUENTE 1: iTUNES (primario)
// imageUrl, release_date, duration, trackNumber, albumTypeDescription,
// genres (parcial), totalTracks, totalAlbumDuration
// ==========================================================================
async function fetchITunes(artist, title, album) {
  const queries = [];
  if (album) queries.push(`${artist} ${title} ${album}`);
  queries.push(`${artist} ${title}`);
  queries.push(title);

  for (const q of queries) {
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=10&country=US`;
      const res = await fetch(url, { headers: { "User-Agent": "RadioMax/1.0" } });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.results || data.results.length === 0) continue;

      const aLow = artist.toLowerCase();
      const tLow = title.toLowerCase();
      let best = null;

      for (const r of data.results) {
        const rArtist = (r.artistName || "").toLowerCase();
        const rTitle  = (r.trackName  || "").toLowerCase();
        if (
          (rArtist.includes(aLow) || aLow.includes(rArtist)) &&
          (rTitle.includes(tLow)  || tLow.includes(rTitle))
        ) {
          best = r;
          break;
        }
      }
      if (!best) best = data.results[0];
      if (best) return best;
    } catch (e) {
      continue;
    }
  }
  return null;
}
__name(fetchITunes, "fetchITunes");

async function fetchITunesAlbum(collectionId) {
  if (!collectionId) return null;
  try {
    const url = `https://itunes.apple.com/lookup?id=${collectionId}&entity=song&limit=200`;
    const res = await fetch(url, { headers: { "User-Agent": "RadioMax/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || data.results.length < 2) return null;
    const tracks   = data.results.filter(r => r.wrapperType === "track");
    const albumInfo = data.results.find(r => r.wrapperType === "collection");
    return { tracks, albumInfo };
  } catch (e) {
    return null;
  }
}
__name(fetchITunesAlbum, "fetchITunesAlbum");

function getAlbumTypeFromITunes(track) {
  const name = (track.collectionName || "").toLowerCase();
  const reissueKeywords = ["remastered","deluxe","expanded","anniversary","edition","reissue","legacy"];
  if (
    track.collectionArtistName &&
    track.collectionArtistName.toLowerCase() === "various artists"
  ) return "Compilación";
  if (reissueKeywords.some(k => name.includes(k))) return "Reedición";
  if (name.includes("- single") || track.trackCount === 1) return "Sencillo";
  return "Álbum";
}
__name(getAlbumTypeFromITunes, "getAlbumTypeFromITunes");

// ==========================================================================
// FUENTE 2: LAST.FM (fallback imagen, géneros extra, fecha aproximada)
// ==========================================================================
async function fetchLastFm(artist, title, apiKey) {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&autocorrect=1&format=json`;
    const res = await fetch(url, { headers: { "User-Agent": "RadioMax/1.0" } });
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
  const album = track.album;
  if (!album || !album.image) return null;
  const sizes = ["extralarge", "mega", "large", "medium"];
  for (const size of sizes) {
    const img = album.image.find(i => i.size === size);
    if (img && img["#text"] && img["#text"].trim() !== "") return img["#text"];
  }
  return null;
}
__name(getBestImageFromLastFm, "getBestImageFromLastFm");

// ==========================================================================
// FUENTE 3: MUSICBRAINZ (ISRC)
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
    if (recording.isrcs && recording.isrcs.length > 0) return recording.isrcs[0];

    const recId = recording.id;
    if (!recId) return null;

    await new Promise(r => setTimeout(r, 1100));

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
// FUENTE 4: DISCOGS (backup silencioso)
// Aporta: imageUrl (si falta), label (si falta), totalAlbumDuration (si falta)
// Estrategia: buscar por artista+título, elegir release con año más cercano
// al que ya tenemos, o el más antiguo si no hay fecha de referencia.
// Autenticación: OAuth consumer key/secret (sin necesidad de token de usuario)
// ==========================================================================
async function fetchDiscogs(artist, title, refYear, consumerKey, consumerSecret) {
  if (!consumerKey || !consumerSecret) return null;

  const authHeader = `Discogs key=${consumerKey}, secret=${consumerSecret}`;

  try {
    // Búsqueda por artista y título en tipo "release"
    const q = `${artist} ${title}`;
    const searchUrl = `https://api.discogs.com/database/search?q=${encodeURIComponent(q)}&type=release&per_page=10&page=1`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        "Authorization": authHeader,
        "User-Agent": "RadioMax/1.0 +https://radiomax.tramax.com.ar"
      }
    });
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    if (!searchData.results || searchData.results.length === 0) return null;

    // Filtrar resultados que tengan al menos el artista en el título del resultado
    const aLow = artist.toLowerCase();
    let candidates = searchData.results.filter(r => {
      const titleField = (r.title || "").toLowerCase();
      return titleField.includes(aLow);
    });
    if (candidates.length === 0) candidates = searchData.results;

    // Elegir el candidato cuyo año sea más cercano al año de referencia (iTunes/Last.fm)
    // o el más antiguo si no hay referencia
    let chosen = null;
    if (refYear) {
      let minDiff = Infinity;
      for (const c of candidates) {
        const y = parseInt(c.year, 10);
        if (!isNaN(y)) {
          const diff = Math.abs(y - refYear);
          if (diff < minDiff) {
            minDiff = diff;
            chosen = c;
          }
        }
      }
    }
    // Fallback: primer candidato con año, o simplemente el primero
    if (!chosen) {
      chosen = candidates.find(c => c.year) || candidates[0];
    }
    if (!chosen || !chosen.id) return null;

    // Obtener detalle del release para label y tracklist (duración total)
    const releaseUrl = `https://api.discogs.com/releases/${chosen.id}`;
    const releaseRes = await fetch(releaseUrl, {
      headers: {
        "Authorization": authHeader,
        "User-Agent": "RadioMax/1.0 +https://radiomax.tramax.com.ar"
      }
    });
    if (!releaseRes.ok) return null;
    const release = await releaseRes.json();

    const result = {
      imageUrl: null,
      label: null,
      totalAlbumDuration: 0
    };

    // Imagen: Discogs devuelve images[]
    if (release.images && release.images.length > 0) {
      // Preferir type="primary", luego cualquiera
      const primary = release.images.find(i => i.type === "primary");
      const img = primary || release.images[0];
      if (img && img.uri) result.imageUrl = img.uri;
    }
    // Fallback: thumbnail del resultado de búsqueda
    if (!result.imageUrl && chosen.cover_image) {
      result.imageUrl = chosen.cover_image;
    }

    // Label: primer label del release
    if (release.labels && release.labels.length > 0) {
      result.label = release.labels[0].name || null;
      // Limpiar nombres genéricos de Discogs
      if (result.label && /^not on label/i.test(result.label)) {
        result.label = null;
      }
    }

    // Duración total: sumar duración de tracklist
    // Discogs usa formato "M:SS" o "H:MM:SS" como string
    if (release.tracklist && release.tracklist.length > 0) {
      let totalMs = 0;
      let allHaveDuration = true;
      for (const t of release.tracklist) {
        if (t.duration && t.duration.trim() !== "") {
          const parts = t.duration.split(":").map(Number);
          let seconds = 0;
          if (parts.length === 2) {
            seconds = parts[0] * 60 + parts[1];
          } else if (parts.length === 3) {
            seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
          }
          totalMs += seconds * 1000;
        } else {
          allHaveDuration = false;
        }
      }
      // Solo usar si al menos la mitad de los tracks tienen duración
      const tracksWithDuration = release.tracklist.filter(
        t => t.duration && t.duration.trim() !== ""
      ).length;
      if (tracksWithDuration >= Math.ceil(release.tracklist.length / 2)) {
        result.totalAlbumDuration = totalMs;
      }
    }

    return result;
  } catch (e) {
    return null;
  }
}
__name(fetchDiscogs, "fetchDiscogs");

// ==========================================================================
// HANDLER PRINCIPAL: /spotify (ruta mantenida para compatibilidad con app.js)
// ==========================================================================
async function handleMetadataRequest(request, env) {
  try {
    const url = new URL(request.url);
    const artist = cleanSearchTerm(url.searchParams.get("artist") || "");
    const title  = cleanSearchTerm(url.searchParams.get("title")  || "");
    const album  = cleanSearchTerm(url.searchParams.get("album")  || "");

    if (!artist || !title) {
      return { status: 400, body: JSON.stringify({ error: "Faltan parámetros." }) };
    }

    const lastfmApiKey     = env.LASTFM_API_KEY     || null;
    const discogsKey       = env.DISCOGS_CONSUMER_KEY    || null;
    const discogsSecret    = env.DISCOGS_CONSUMER_SECRET || null;

    // Respuesta base — mismos campos que antes esperaba el app.js
    const resp = {
      imageUrl:             null,
      release_date:         null,
      label:                null,
      genres:               [],
      duration:             0,
      totalTracks:          null,
      totalAlbumDuration:   0,
      trackNumber:          null,
      albumTypeDescription: "Álbum",
      isrc:                 null,
      links:                null,
      debugSpotifyUrl:      null  // mantenido por compatibilidad, siempre null
    };

    // -----------------------------------------------------------------------
    // FUENTE 1: iTUNES (primario)
    // -----------------------------------------------------------------------
    const iTunesTrack = await fetchITunes(artist, title, album);

    if (iTunesTrack) {
      if (iTunesTrack.artworkUrl100) {
        resp.imageUrl = iTunesTrack.artworkUrl100
          .replace("100x100bb", "600x600bb")
          .replace("100x100", "600x600");
      }
      if (iTunesTrack.releaseDate) {
        resp.release_date = iTunesTrack.releaseDate.substring(0, 10);
      }
      if (iTunesTrack.trackTimeMillis) {
        resp.duration = msToSeconds(iTunesTrack.trackTimeMillis);
      }
      if (iTunesTrack.trackNumber) {
        resp.trackNumber = iTunesTrack.trackNumber;
      }
      resp.albumTypeDescription = getAlbumTypeFromITunes(iTunesTrack);
      if (iTunesTrack.primaryGenreName) {
        resp.genres = [iTunesTrack.primaryGenreName];
      }

      if (iTunesTrack.collectionId) {
        const albumData = await fetchITunesAlbum(iTunesTrack.collectionId);
        if (albumData && albumData.tracks.length > 0) {
          resp.totalTracks = albumData.tracks.length;
          resp.totalAlbumDuration = albumData.tracks.reduce(
            (sum, t) => sum + (t.trackTimeMillis || 0), 0
          );
        } else {
          resp.totalTracks = iTunesTrack.trackCount || null;
        }
      } else {
        resp.totalTracks = iTunesTrack.trackCount || null;
      }
    }

    // -----------------------------------------------------------------------
    // FUENTE 2: LAST.FM (fallback imagen, géneros extra, fecha aproximada)
    // -----------------------------------------------------------------------
    let lfmTrack = null;
    if (lastfmApiKey) {
      lfmTrack = await fetchLastFm(artist, title, lastfmApiKey);
      if (lfmTrack) {
        if (!resp.imageUrl) {
          const lfmImg = getBestImageFromLastFm(lfmTrack);
          if (lfmImg) resp.imageUrl = lfmImg;
        }
        if (!resp.release_date && lfmTrack.album?.wiki?.published) {
          const match = lfmTrack.album.wiki.published.match(/\d{4}/);
          if (match) resp.release_date = match[0] + "-01-01";
        }
        if (lfmTrack.toptags && lfmTrack.toptags.tag) {
          const lfmGenres = lfmTrack.toptags.tag
            .slice(0, 3)
            .map(t => t.name)
            .filter(g => g && g.length > 1 && !/^\d+$/.test(g));
          resp.genres = [...new Set([...resp.genres, ...lfmGenres])].slice(0, 3);
        }
        if (!resp.duration && lfmTrack.duration) {
          const dur = parseInt(lfmTrack.duration, 10);
          if (dur > 0) resp.duration = msToSeconds(dur);
        }
      }
    }

    // -----------------------------------------------------------------------
    // FUENTE 3: MUSICBRAINZ (ISRC)
    // -----------------------------------------------------------------------
    const isrc = await fetchMusicBrainzIsrc(artist, title);
    if (isrc) resp.isrc = isrc.toUpperCase();

    // -----------------------------------------------------------------------
    // FUENTE 4: DISCOGS (backup silencioso)
    // Solo se llama si falta al menos uno de: imageUrl, label, totalAlbumDuration
    // -----------------------------------------------------------------------
    const needsDiscogs =
      !resp.imageUrl ||
      !resp.label ||
      resp.totalAlbumDuration === 0;

    if (needsDiscogs && discogsKey && discogsSecret) {
      // Año de referencia para elegir el release más apropiado
      const refYear = resp.release_date
        ? parseInt(resp.release_date.substring(0, 4), 10)
        : null;

      const discogsData = await fetchDiscogs(
        artist, title, refYear, discogsKey, discogsSecret
      );

      if (discogsData) {
        // imageUrl: solo si no lo tiene ninguna fuente anterior
        if (!resp.imageUrl && discogsData.imageUrl) {
          resp.imageUrl = discogsData.imageUrl;
        }
        // label: solo si está vacío
        if (!resp.label && discogsData.label) {
          resp.label = discogsData.label;
        }
        // totalAlbumDuration: solo si está en 0
        if (resp.totalAlbumDuration === 0 && discogsData.totalAlbumDuration > 0) {
          resp.totalAlbumDuration = discogsData.totalAlbumDuration;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Si ninguna fuente encontró nada útil
    // -----------------------------------------------------------------------
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

      // /spotify mantenido como ruta para compatibilidad con app.js
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
        Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        Object.entries(noCacheHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        Object.entries(securityHeaders).forEach(([k, v]) => finalHeaders.set(k, v));
        return new Response(response.body, {
          status: response.status,
          headers: finalHeaders
        });
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
          headers: { ...corsHeaders, "Content-Type": "application/json", ...noCacheHeaders }
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
