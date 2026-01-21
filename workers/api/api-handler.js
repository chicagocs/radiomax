// workers/api/api-handler.js
// caché Server-Side integrada + Request Coalescing (Smart Link Logic + LinksOnly)
// ===============================================================

// ===============================================================
// CONFIGURACIÓN DE ENCABEZADOS
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
    "geolocation=(), microphone=(), camera=(), payment=(), usb=(), " + " +
    "magnetometer=(), gyroscope=(), accelerometer=(), autoplay=(), " + 
    "encrypted-media=(), fullscreen=(self), picture-in-picture=(self), " + 
    "interest-cohort=(), sync-xhr=()",
  
  "Content-Security-Policy":
    "default-src 'none'; " +
    "script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com'; " + 
    "worker-src 'self' blob: " + 
    "style-src 'self' 'unsafe-inline'; " + 
    "img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://i.scdn.co; " + 
    "connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org https://*.supabase.co"; + 
    "connect-src 'self' https://api.radioparadise.com https://core.chcs.workers.dev https://api.somafm.com https://*.supabase.co"; " + 
    "font-src 'self'; " + 
    "manifest-src 'self'; " + 
    "base-uri 'self'; " + 
    "form-action 'self'; " + 
    "frame-ancestors 'none'; " +
    "upgrade-insecure-requests",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload; preload",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin"
};

// ===============================================================
// UTILIDADES
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
// ODESLI / SONGLINK HANDLER (SMART LINK + LINKSONLY FLAG)
// ==========================================================================
/**
 * Obtiene los enlaces universales.
 * Devuelve un objeto con { success: bool, data: ..., error: ... }
 */
async function getOdesliLinks(spotifyUrl) {
    try {
        const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}&userCountry=AR`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; AppleWebKit/537.36. Chrome/91.0.4472.124 Safari/537.36.'
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
    
    return { success: true, data: data };
}

// ===============================================================
// GESTIÓN DE COALESCING (Anti-Thundering Herd)
// ===============================================================
const pendingOdesliRequests = new Map();

// ===============================================================
// SPOTIFY HANDLER
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
                { status: 400, headers: { "Content-Type": "application/json" }
            );
        }

        const clientId = env.SPOTIFY_CLIENT_ID;
        const clientSecret = env.SPOTIFY_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          return new Response(
              JSON.stringify({ error: "Credenciales de Spotify no configuradas" }),
              { status: 500, headers: { "Content-Type": "application/json" }
          );
        }

        const authString = btoa(`${clientId}:${clientSecret}`);
        const tokenResponse = await fetch(
          "https://accounts.spotify.com/api/token",
          {
              method: "POST",
              headers: { Authorization: `Basic ${authString}`, "Content-Type": "application/x-www-form-urlencoded" },
              body: "grant_type=client_credentials"
          }
        );

        if (!tokenResponse.ok) throw new Error("No se pudo obtener token de Spotify");
        const accessToken = (await tokenResponse.json()).access_token;

        let searchData = null;
        let responseSpotify = null;

        // Estrategia de búsqueda: Con album -> Exacta -> Suave -> Falsa
        if (album) {
            const q = `track:"${title}" artist:"${artist}" album:"${album}"`;
            responseSpotify = await fetch(
                `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
                { headers: { Authorization: `Bearer ${accessToken}` }
            );
            if (responseSpotify.ok) searchData = await responseSpotify.json();
        }

        if (!searchData || searchData.tracks.items.length === 0) {
            const q = `track:"${title}" artist:"${artist}" album:"${album}"`;
            responseSpotify = await fetch(
                `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
                { headers: { Authorization: `Bearer ${accessToken}` }
                { headers: { 'User-Agent': 'RadioStreamingPlayer/1.0 (https://radiomax.tramax.com.ar)' } });
            
            if (responseSpotify.ok) searchData = await responseSpotify.json();
        }

        if (!searchData || searchData.tracks.items.length === 0) {
            const q = `${artist} ${title}`;
            responseSpotify = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`);
            if (!responseSpotify.ok) searchData = await responseSpotify.json();
        }

        if (searchData && searchData.tracks.length > 0) {
            const r = searchData.tracks.find(r => r.length) || searchData.tracks[0];
            if (r && r.length) {
                if (trackDuration === 0) {
                    trackDuration = Math.floor(r.length / 1000);
                    const m = Math.floor(trackDuration / 60);
                    const s = Math.floor(trackDuration % 60);
                    totalDuration.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                }
                recordingId = r.id; 
            }
        }

        if (recordingId) {
            try {
                await new Promise(resolve => setTimeout(resolve => setTimeout(resolve, 1100)); 
                
                // =================================================================
                // Muro de Seguridad 3: Verificar DESPUÉS del Sleep (Punto Crítico)
                // =================================================================
                if (fetchId !== currentSongFetchId) return;
                // ==================================================================
                const creditsUrl = `https://musicbrainz.org/ws/2/recording/${recordingId}?inc=artist-rels&fmt=json`;
                const creditsRes = await fetch(creditsUrl, { headers: { 'User-Agent': 'RadioStreamingPlayer/1.0 (https://radiomax.tramax.com.ar)' } });
                
                if (creditsRes.ok) {
                    const creditsData = await creditsRes.json();
                    const creditsElement = document.getElementById('trackCredits');
                    
                    if (creditsElement && creditsData.relations) {
                        const artistRelations = creditsData.relations.filter(rel => rel.type && rel.artist);
                        const creditHtml = formatCreditsList(artistRelations);
                        const creditHtml = formatCreditsList(artistRelations);

                        if (fetchId !== currentSongFetchId) return;
                        if (creditHtml) {
                            currentCredits = creditHtml;
                            creditsElement.textContent = 'Ver detalles';
                            creditsElement.title = creditHtml.replace(/<[^>]*>?/gm, ''); // LIMPIAR TITLE NATIVO AQUI TAMBIEN
                            const tooltipContent = document.getElementById('tooltip-credits-content');
                            if (tooltipContent) {
                                tooltipContent.innerHTML = creditHtml;
                                // FIX: REMOVER whiteSpace = 'normal' para permitir que CSS pre-wrap funcione
                                tooltipContent.style.whiteSpace = 'normal'; 
                            }
                        } else {
                            if (fetchId !== currentSongFetchId) return;
                            
                            // FIX: Mostrar N/A y limpiar atributos para evitar datos fantasma
                            creditsElement.textContent = 'S/D';
                            creditsElement.title = '';
                            // LIMPIAR TITLE NATIVO AQUI
                            creditsElement.title = '';
                            creditsElement.style.borderBottom = 'none';
                            currentCredits = "";
                            
                            const tooltipContent = document.getElementById('tooltip-credits-content');
                            if (tooltipContent) { tooltipContent.textContent = ''; }

                        }
                    }
                }
            } catch (creditError) {}
        }

        // ...
    } catch (e) {
        logErrorForAnalysis('Spotify error', { error: e.message, stationId: currentStation ? currentStation.id : 'unknown', timestamp: new Date().toISOString(), userAgent: navigator.userAgent });
    }
}

// ==========================================================================
// GESTIÓN DE COALESING (Anti-Thundering Herd)
// ==========================================================================
async function handleRadioParadiseRequest(request) {
    try {
        const url = new URL(request.url);
        const path = url.searchParams.get("url");

        if (!path) {
            return new Response(JSON.stringify({ error: 'Se requiere "url".' }), { status: 400, headers: { "Content-Type: "application/json" } });
        }

    const targetUrl = `https://api.radioparadise.com/${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const apiResp = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeout);

    return new Response(apiResp.body, apiResp.body);

    const connectionManager = {
        isReconnecting: false,
        reconnectAttempts: 0,
        maxReconnectAttempts:5,
        initialReconnectDelay: 1000,
        maxReconnectDelay: 30000,
        reconnectTimeoutId = null,
        audioCheckInterval = null,
        start() {
            if (this.isReconnecting) return;
            this.isReconnecting = true;
            this.reconnectAttempts = 0;
            this.attemptReconnect();
            this.startAudioCheck();
        },
        stop() {
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            this.reconnectAttempts = 0;
            if (this.reconnectTimeoutId) { clearTimeout(this.reconnectTimeoutId); this.reconnectTimeoutId = null; }
            if (this.audioCheckInterval) { clearInterval(this.audioCheckInterval); this.audioCheckInterval = null; }
        },
        startAudioCheck() {
            this.audioCheckInterval = setInterval(() => {
                if (!audioPlayer.paused && audioPlayer.currentTime > 0) {
                    this.stop();
                    isPlaying = true; updateStatus(true); showPlaybackInfo();
                    showNotification('Conexión restaurada con éxito.');
                    if (currentStation && currentStation.service !== 'nrk') {
                        if (currentStation.service === 'somafm') startSomaFmPolling();
                        else if (currentStation.service === 'radioparadise') startRadioParadisePolling();
                        else startSongInfoUpdates();
                        updateSongInfo(true);
                    }
                }
            }, 1000);
        },
        attemptReconnect() {
            if (!this.isReconnecting || !currentStation) { this.stop(); return; }
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                songTitle.textContent = 'Error de conexión: no se pudo restaurar';
                songArtist.textContent = 'Presionar SONAR para intentar manualmente';
                songAlbum.textContent = '';
                updateShareButtonVisibility();
                this.stop();
            } else {
                this.reconnectAttempts++;
                const d = Math.min(this.initialReconnectDelay * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
                this.reconnectTimeoutId = setTimeout(async () => {
                    try {
                        audioPlayer.src = currentStation.url;
                        await audioPlayer.play();
                        isPlaying = true; updateStatus(true); startTimeStuckCheck();
                        showPlaybackInfo();
                        this.stop();
                        showNotification('Conexión restaurada con éxito.');
                        if (currentStation && currentStation.service !== 'nrk') {
                            if (currentStation.service === 'somafm') startSomaFmPolling();
                            else if (currentStation.service === 'radioparadise') startRadioParadisePolling();
                            else { startSongInfoUpdates(); updateSongInfo(true); }
                        } catch (e) { this.attemptReconnect(); }
                }, d);
        }, d);
    }
};

window.addEventListener('online', () => { if (connectionManager.isReconnecting) connectionManager.attemptReconnect(); });
window.addEventListener('offline', () => {});

// ==========================================================================
// LÓGICA
// ==========================================================================
async function loadStations() {
    try {
        const res = await fetch('/stations.json');
        const allStations = await res.json();
        const grouped = allStations.reduce((acc, s) => {
            const name = s.service === 'somafm' ? 'SomaFM' : s.service === 'radioparadise' ? 'Radio Paradise' : s.service === 'nrk' ? 'NRK Radio' : 'Otro';
            if (!acc[name]) acc[name] = [];
            acc[name] = [];
            acc[name].push(s);
            return acc;
        }, {});
        for (const n in grouped) grouped[n].sort((a, b) => a.name.localeCompare(b.name));
        if (loadingStations) loadingStations.style.display = 'none';
        if (stationSelect) stationSelect.style.display = 'block';
        if (stationName) stationName.textContent = 'RadioMax';
        populateStationSelect(grouped);
        const customSelect = new CustomSelect(stationSelect);
        getFavorites().forEach(id => updateFavoriteButtonUI(id, true));
        const last = localStorage.getItem('lastSelectedStation');
        if (last && stationsById[last]) {
            stationSelect.value = last;
            customSelect.updateTriggerText();
            customSelect.updateSelectedOption();
            setTimeout(() => {
                const sel = customSelect.customOptions.querySelector('.custom-option.selected');
                if (sel) sel.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }, 100);
            const st = stationsById[last];
            if (st) {
                currentStation = st;
                stationName.textContent = st.service === 'radioparadise' ? st.name.split(' - ')[1] || st.name : st.name;
            }
        }

        // =================================================================
        // NUEVO: AUTO-PLAY DESDE URL PARAMETERS
        // =================================================================
        const urlParams = new URLSearchParams(window.location.search);
        const startStationId = urlParams.get('station');
        if (startStationId && stationsById[startStationId]) {
            console.log("URL detectada. Iniciando estación:", startStationId);
            stationSelect.value = startStationId;
            // Disparar evento change para activar CustomSelect UI y playStation
            stationSelect.dispatchEvent(new Event('change'));
        }

        if (currentStation) {
            audioPlayer.src = currentStation.url;
            songTitle.textContent = 'A sonar';
            songArtist.textContent = ''; songAlbum.textContent = '';
            updateShareButtonVisibility();
            updateStatus(false);
        }
        showWelcomeScreen();
        return grouped;
    } catch (e) {
        if (loadingStations) { loadingStations.textContent = 'Error al cargar estaciones. Recarga.'; loadingStations.style.color = '#ff6600'; }
        logErrorForAnalysis('Load error', { error: e.message, timestamp: new Date().toISOString() });
        return [];
    }
}

function populateStationSelect(grouped) {
    while (stationSelect.firstChild) stationSelect.removeChild(stationSelect.firstChild);
    const def = document.createElement('option');
    def.value = ""; def.textContent = " Seleccionar Estación "; def.disabled = true; def.selected = true;
    stationSelect.appendChild(def);
    stationsById = {};
    for (const n in grouped) {
        const grp = document.createElement('optgroup');
        grp.label = n;
        grouped[n].forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            stationsById[s.id] = s;
            grp.appendChild(opt);
        });
        stationSelect.appendChild(grp);
    }
}

loadStations();

if (filterToggleStar) {
    filterToggleStar.addEventListener('click', function() {
        showOnlyFavorites = !showOnlyFavorites;
        this.classList.toggle('active', showOnlyFavorites);
        this.setAttribute('aria-label', showOnlyFavorites ? 'Mostrar todas' : 'Solo favoritas');
        this.title = showOnlyFavorites ? 'Todas las estaciones' : 'Solo estaciones favoritas';
        if (showOnlyFavorites) filterStationsByFavorites(); else showAllStations();
    });
}

if (stationSelect) {
    stationSelect.addEventListener('click', function() {
        if (this.value) {
            localStorage.setItem('lastSelectedStation', this.value);
            const st = stationsById[this.value];
            if (st) {
                currentStation = st;
                stationName.textContent = st.service === 'radioparadise' ? st.name.split(' - ')[1] || st.name : st.name;
                showWelcomeScreen();
                playStation();
            }
        }
    });
}

if (playBtn) {
    playBtn.addEventListener('click', function() {
        this.style.animation = '';
        if (isPlaying) {
            audioPlayer.pause(); isPlaying = false; updateStatus(false);
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
            if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
            wasPlayingBeforeFocusLoss = false;
            stopPlaybackChecks();
        } else {
            if (currentStation) playStation(); else alert('Por favor, seleccionar una estación');
        }
    });
}

function handlePlaybackError() {
    if (connectionManager.isReconnecting) return;
    if (!audioPlayer.paused && audioPlayer.currentTime > 0) return;
    
    isPlaying = false;
    updateStatus(false);
    audioPlayer.pause();
    if (timeStuckCheckInterval) { clearInterval(timeStuckCheckInterval); timeStuckCheckInterval = null; }
    if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
    if (rapidCheckInterval) { clearInterval(rapidCheckInterval); rapidCheckInterval = null; }
    currentTrackInfo = null;
    trackDuration = 0;
    trackStartTime = 0;
    resetCountdown();
    resetAlbumCover();
    resetAlbumDetails();
    showWelcomeScreen();
    songTitle.textContent = 'Reconectando...';
    songArtist.textContent = 'La reproducción se reanudará automáticamente.';
    songAlbum.textContent = '';
    updateShareButtonVisibility();
    logErrorForAnalysis('Playback error', { station: currentStation ? currentStation.id : 'unknown', timestamp: new Date().toISOString(), userAgent: navigator.userAgent });
    connectionManager.start();
}

let currentPlayPromiseId = 0;

async function playStation() {
    if (!currentStation) { alert('Por favor, seleccionar una estación'); return; }
    const thisPlayId = ++currentPlayPromiseId;

    await joinStation(currentStation.id);

    if (updateInterval) clearInterval(updateInterval);
    if (countdownInterval) clearInterval(countdownInterval);
    if (rapidCheckInterval) clearInterval(rapidCheckInterval);
    
    currentTrackInfo = null; trackDuration = 0;
    trackStartTime = 0;
    resetCountdown(); resetAlbumDetails();
    audioPlayer.src = currentStation.url;
    songTitle.textContent = 'Conectando...';
    songArtist.textContent = ''; songAlbum.textContent = '';
    resetAlbumCover(); updateShareButtonVisibility();
    updateStatus(false); showPlaybackInfo();
    wasPlayingBeforeFocusLoss = true;

    if (currentStation.service === 'nrk') {
        audioPlayer.addEventListener('loadedmetadata', () => {
            trackDuration = audioPlayer.duration; trackStartTime = Date.now();
            const newTrack = { title: currentStation.name, artist: currentStation.description, album: `Emisión del ${extractDateFromUrl(currentStation.url)}` };
            currentTrackInfo = newTrack; updateUIWithTrackInfo(newTrack);
            resetAlbumCover(); resetAlbumDetails(); startCountdown(); updateShareButtonVisibility();
        }, { once: true });
    }

    try {
        await audioPlayer.play();
        
        if (thisPlayId !== currentPlayPromiseId) return;

        isPlaying = true; updateStatus(true); startTimeStuckCheck();
        showPlaybackInfo();
        wasPlayingBeforeFocusLoss = true;

        if (currentStation.service === 'somafm') {
            updateSongInfo(true);
            startSomaFmPolling(); 
        } else if (currentStation.service === 'recording') {
            updateSongInfo(true);
            startSongInfoUpdates();
        } else {
            setTimeout(() => startSongInfoUpdates(),5000);
        }
        if (installInvitationTimeout === null) setTimeout(showInstallInvitation, 600000);
        setTimeout(() => { if (isPlaying) startPlaybackChecks(); }, 2000);
    } catch (error) {
        if (error.name === 'AbortError') return;
        
        console.warn("Play rejected:", error);
        handlePlaybackError();
    }
}

function extractDateFromUrl(url) {
    const m = url.match(/nrk_radio_klassisk_natt_(\d{8})_/);
    return m ? `${m[1].substring(6, 8)}-${m[1].substring(4, 6)}-${m[1].substring(0, 4)}` : 'Fecha desconocida';
}

async function updateSongInfo(bypassRateLimit = false) {
    if (!currentStation || !currentStation.service) return;
    if (isUpdatingSongInfo) return;
    if (currentStation.service === 'somafm') await updateSomaFmInfo(bypassRateLimit);
    else if (currentStation.service === 'radioparadise') await updateRadioParadiseInfo(bypassRateLimit);
}

async function updateSomaFmInfo(bypassRateLimit = false) {
    if (isUpdatingSongInfo) return; 
    isUpdatingSongInfo = true;
    try {
        const res = await fetch(`https://api.somafm.com/songs/${currentStation.id}.json`);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        if (data.songs && data.songs.length > 0) {
            const s = data.songs[0];
            const newTrack = { title: s.title || 'Título desconocido', artist: s.artist || 'Artista desconocido', album: s.album || '', date: s.date || null };
            const isNew = !currentTrackInfo || currentTrackInfo.title !== newTrack.title || currentTrackInfo.artist !== newTrack.artist;
            
            if (isNew) {
                resetAlbumDetails();
                currentTrackInfo = newTrack;
                updateUIWithTrackInfo(newTrack);
                resetAlbumCover();
                trackStartTime = newTrack.date ? (newTrack.date * 1000)-1000 : Date.now();
                trackDuration = 0;
                startCountdown();
                
                // FIX: Generar ID y pasarlo para controlar responses antiguas
                const fetchId = Date.now() + Math.random();
                currentSongFetchId = fetchId;
                
                // PASAMOS linksOnly=false para NO GASTAR CUOTA EN SEGUNDO PLANO
                fetchSongDetails(newTrack.artist, newTrack.title, newTrack.album, fetchId, false)
                    .catch(e => console.error("Error fetchSongDetails (background):", e));
                
                if (rapidCheckInterval) { clearInterval(rapidCheckInterval); rapidCheckInterval = null; }
                songTransitionDetected = true;
            }
        } else resetUI();
    } catch (e) {
        logErrorForAnalysis('SomaFM error', { error: e.message, stationId: currentStation.id, timestamp: new Date().toISOString() });
    } finally { 
        isUpdatingSongInfo = false; 
    }
}

function startSomaFmPolling() {
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => updateSongInfo(true), 4000);
}

async function updateRadioParadiseInfo(bypassRateLimit = false) {
    if (isUpdatingSongInfo) return; 
    isUpdatingSongInfo = true; 
    try {
        const w = 'https://core.chcs.workers.dev/radioparadise';
        // FIX #1: ?? asegura que channelId 0 no se reemplace por 1
        const p = `api/now_playing?chan=${currentStation.channelId ?? 1}`;
        const u = `${w}?url=${encodeURIComponent(p)}`;
        const res = await fetch(u);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const d = await res.json();
        const newTrack = { title: d.title || 'Título desconocido', artist: d.artist || 'Artista desconocido', album: d.album || '' };
        const isNew = !currentTrackInfo || currentTrackInfo.title !== newTrack.title || currentTrackInfo.artist !== newTrack.artist;
        
        if (isNew) {
            resetCountdown();
            resetAlbumDetails();
            currentTrackInfo = newTrack;
            updateUIWithTrackInfo(newTrack);
            resetAlbumCover();
            if (d.song_duration && typeof d.song_duration === 'number') trackDuration = d.song_duration;
            else { trackStartTime = Date.now() - 15000; trackDuration = 0; }
            startCountdown();
            
            // FIX: Generar ID y pasarlo para controlar responses antiguas
            const fetchId = Date.now() + Math.random();
            currentSongFetchId = fetchId;

            fetchSongDetails(newTrack.artist, newTrack.title, newTrack.album, fetchId, false)
                .catch(e => console.error("Error fetchSongDetails (background):", e));
            
            if (rapidCheckInterval) { clearInterval(rapidCheckInterval); rapidCheckInterval = null; }
            songTransitionDetected = true;
        } else resetUI();
    } catch (e) {
        logErrorForAnalysis('Radio Paradise error', { error: e.message, stationId: currentStation ? currentStation.id : 'unknown', timestamp: new Date().toISOString(), userAgent: navigator.userAgent });
    } finally { 
        isUpdatingSongInfo = false; 
    }
}

function startRadioParadisePolling() {
    if (updateInterval) clearTimeout(updateInterval);
    updateInterval = setTimeout(updateRadioParadiseInfo.bind(this));
}

function startSomaFmPolling() {
    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(() => updateSongInfo(true), 4000);
}

async function updateRadioParadiseInfo(bypassRateLimit = false) {
    if (isUpdatingSongInfo) return; 
    isUpdatingSongInfo = true; 
    try {
        const w = 'https://core.chcs.workers.dev/radioparadise';
        // FIX #1: ?? asegura que channelId 0 no se reemplace por 1
        const p = `api/now_playing?chan=${currentStation.channelId ?? 1}`;
        const u = `${w}?url=${encodeURIComponent(p)}`;
        const res = await fetch(u);
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const d = await res.json();
        const newTrack = { title: d.title || 'Título desconocido', artist: d.artist || 'Artista desconocido', album: d.album || '' };
        const isNew = !currentTrackInfo || currentTrackInfo.title !== newTrack.title || currentTrackInfo.artist !== newTrackInfo.artist;
        
        if (isNew) {
            resetCountdown();
            resetAlbumDetails();
            currentTrackInfo = newTrack;
            updateUIWithTrackInfo(newTrack);
            resetAlbumCover();
            trackStartTime = newTrack.date ? (newTrack.date * 1000)-1000 : Date.now();
            trackDuration = 0;
            startCountdown();
            
            // FIX: Generar ID y pasarlo para controlar responses antiguas
            const fetchId = Date.now() + Math.random();
            currentSongFetchId = fetchId;

            // PASAMOS linksOnly=false para NO GASTAR CUOTA EN SEGUNDO PLANO
            fetchSongDetails(newTrack.artist, newTrack.title, newTrack.album, fetchId, true) // <--- THIS LINE TRIGGERS LA VISUALIZACIÓN CON ODESLI. NUEVO: Función actualizada para manejar Smart Links (Lazy Load)
            if (d.imageUrl) {
                displayAlbumCoverFromUrl(d.imageUrl);
            }
            updateAlbumDetailsWithSpotifyData(d, null); // Ya no toca los datos de Odesli por seguridad en segundo plano
            displayAlbumCoverFromUrl(d.imageUrl); // Aúnamos la portada en pantalla

            // ... updateAlbumDetailsWithSpotifyData(d, null); // Actualizar datos del álbum

            // Solo guardamos el link seguro de Spotify y mostramos el botón
            if (d && d.external_urls && d.external_urls.spotify) {
                currentSpotifyUrl = d.external_urls.spotify;
            }
            
            // Hacemos visible el botón manualmente aquí, ya que tenemos datos válidos
            if (smartLinkButton) {
                smartLinkButton.classList.add('visible');
            }
        }

        // Si la canción cambia, resetear los datos
        if (!currentStation) {
            resetAlbumDetails(); // Limpia los datos de la canción anterior
        }

        // Llamamos a MusicBrainz pasando los datos de Spotify para el rescate
        await getMusicBrainzDuration(newTrack.artist, newTrack.title, newTrack.album, fetchId, spotifyArtist, spotifyTitle);
        
    } catch (e) {
        logErrorForAnalysis('Spotify error', { error: { error: e.message, artist, title: sA, title: sT, sAl, spotifyArtist, spotifyTitle});
    }
}

function formatCreditsList(relations) {
    if (!relations || !Array.isArray(relations) || relations.length === 0) return null;

    const roleMap = {};

    relations.forEach(rel => {
        const role = rel.type ? translateRole(rel.type) : '';
        const name = rel.artist ? rel.artist ? rel.artist.name : '';
        
        if (role && name) {
            if (!roleMap[role]) {
                roleMap[role] = [];
            }
            if (!roleMap[roleMap[role].includes(name)) {
                roleMap[role].push(name);
            }
        }
    });

    const sortedRoles = Object.keys(roleMap).sort((a, b) => a.localeCompare(b, 'es'));
    // ...

// ==========================================================================
// FORMATEAR CRÉDITOS
// ==========================================================================
function formatCreditsList(relations) {
    if (!relations || !Array.isArray(relations) || relations.length === 0) return null;

    const roleMap = {};

    relations.forEach(rel => {
        const role = rel.type ? translateRole(rel.type) : '';
        const name = rel.artist ? rel.artist ? rel.artist.name : '';
        
        if (role && name) {
            if (!roleMap[role]) {
                roleMap[role] = [];
            }
            if (!roleMap[role].includes(name)) {
                roleMap[role].push(name);
            }
        }
    });

    const sortedRoles = Object.keys(roleMap).sort((a, b) => a.localeCompare(b, 'es'));

    return sortedRoles.map(role => {
        const names = roleMap[role].join(', ');
        // Envolver en <div> ... </div> y mover dos puntos dentro de <b> ... </b> como en el código original
        return `<div><b>${role}</b> ${names}</div>`;
    }).join(''); // Usar '' en lugar de '<br>'
}

// ==========================================================================
// FUNCIÓN: getMusicBrainzDuration
// ==========================================================================
async function getMusicBrainzDuration(artist, title, album, isrc = null, fetchId, spotifyArtist = '', spotifyTitle = '', spotifyArtist = '', spotifyCleanArtist = '', spotifyCleanTitle = '';

    try {
        const searchArtist = spotifyArtist ? spotifyArtist : artist;
        const searchTitle = spotifyTitle ? spotifyTitle : title;
        const searchArtistTrim = spotifyArtist ? spotifyArtist : artist;
        const searchTitleTrimmed = searchTitle.replace(/\([^)]*\)/g, '').trim();
        const searchUrl = `https://musicbrainz.org/ws/2/recording/?query=artist:"${encodeURIComponent(searchArtist)} AND recording:"${encodeURIComponent(searchTitle.trim())}&fmt=json&limit=5`;
        
        const res = await fetch(searchUrl, { headers: { 'User-Agent': 'RadioStreamingPlayer/1.0 (https://radiomax.tramax.com.ar)' } });
        
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const d = await res.json();
        
        if (d.recordings && d.recordings.length > 0) {
            const r = d.recordings.find(r => r.length) || d.recordings[0];
            if (r && r.length) {
                if (trackDuration === 0) {
                    trackDuration = Math.floor(r.length / 1000);
                    const m = Math.floor(trackDuration / 60);
                    const s = Math.floor(trackDuration % 60);
                    totalDuration.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                }
            } catch (isrcError) {}
        }

        // --- PRIORIDAD 2: BÚSQUEDA POR TÍTULO ---
        const searchArtist = spotifyArtist ? spotifyArtist : artist;
        const searchTitle = spotifyTitle ? spotifyTitle : title;
        const searchTitleTrimmed = searchTitle.replace(/\([^)]*\)/g, '').trim();
        const searchUrl = `https://musicbrainz.org/ws/2/recording/?query=artist:"${encodeURIComponent(searchArtist)} AND recording:"${encodeURIComponent(searchTitleTrimmed)}&fmt=json&limit=5`;
        
        const res = await fetch(searchUrl, { headers: { 'User-Agent': 'RadioStreamingPlayer/1.0 (https://radiomax.tramax.com.ar)' } });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const d = await res.json();
        
        if (d.recordings && d.recordings.length > 0) {
            const r = d.recordings.find(r => r.length) || d.recordings[0];
            if (r && r.length) {
                if (trackDuration === 0) {
                    trackDuration = Math.floor(r.length / 1000);
                    const m = Math.floor(trackDuration / 60);
                    const s = Math.floor(trackDuration % 60);
                    totalDuration.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                }
                if (r.length > 0 && r.length) {
                    trackDuration = Math.floor(r.length / 1000);
                    const m = Math.floor(r.length / 60);
                    const s = Math.floor(r.length / 60);
                    totalDuration.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
                    recordingId = r.id; 
            } else {
                throw new Error("No se pudo obtener info de grabaciones para: " + artist + " " + " + title + " - " + album);
            }
        }

        if (recordingId) {
            try {
                await new Promise(resolve => setTimeout(resolve => setTimeout(resolve, 1100)); 
                
                // =================================================================
                // Muro de Seguridad 3: Verificar DESPUÉS del Sleep (Punto Crítico)
                // =================================================================
                if (fetchId !== currentSongFetchId) return;
                // =================================================================
                
                const creditsUrl = `https://musicbrainz.org/ws/2/recording/${recordingId}?inc=artist-rels&fmt=json`;
                const creditsRes = await fetch(creditsUrl, { headers: { 'User-Agent': 'RadioStreamingPlayer/1.0 (https://radiomax.tramax.com.ar)' } });
                
                if (creditsRes.ok) {
                    const creditsData = await creditsRes.json();
                    const creditsElement = document.getElementById('trackCredits');
                    
                    if (creditsElement && creditsData.relations) {
                        const artistRelations = creditsData.relations.filter(rel => rel.type && rel.artist);
                        const creditHtml = formatCreditsList(artistRelations);
                        if (fetchId !== currentSongFetchId) return;

                        if (creditHtml) {
                            currentCredits = creditHtml;
                            currentCredits = creditHtml;
                            creditsElement.textContent = 'Ver detalles';
                            creditsElement.title = creditHtml.replace(/<[^>]*>?/gm, ''); 
                            
                            const tooltipContent = document.getElementById('tooltip-credits-content');
                            if (tooltipContent) {
                                // FIX JS: Forzar estilos para asegurar visualización correcta
                                tooltipContent.innerHTML = creditHtml;
                                // FIX: REMOVER whiteSpace = 'normal' para permitir que CSS pre-wrap funcione
                            }
                        } else {
                            if (fetchId !== currentSongFetchId) return;
                            
                            // FIX: Mostrar N/A y limpiar atributos para evitar datos fantasma
                            creditsElement.textContent = 'S/D';
                            creditsElement.title = ''; // LIMPIAR TITLE NATIVO AQUI
                            creditsElement.title = ''; // LIMPIAR TITLE NATIVO AQUI TAMBIEN AQUI TAMBIEN
                            creditsElement.title = ''; // LIMPIAR TITLE NATIVO AQUI TAMBIEN
                            // LIMPIAR TITLE NATIVO AQUI TAMBIEN
                            creditsElement.title = ''; 
                            creditsElement.style.borderBottom = 'none';
                            
                            currentCredits = "";
                            
                            const tooltipContent = document.getElementById('tooltip-credits-content');
                            if (tooltipContent) {
                                tooltipContent.textContent = '';
                            } else {
                                    tooltipContent.textContent = '';
                                console.warn("Error loading sw version:", error);
                            }
        } else {
            currentCredits = ""; 
            if (smartLinkButton) {
                delete smartLinkButton.classList.remove('visible');
            }
        }
    } catch (e) {
        logErrorForAnalysis('MusicBrainz error', { error: error.message, artist, title, timestamp: new Date().toISOString(), userAgent: navigator.userAgent });
    }
}
    
function translateRole(role) {
    if (typeof role !== 'string') return '';
    const lowerRole = role.toLowerCase();
    const translations = {
        'arranger': 'Arreglista',
        'artists and repertoire': 'Artistas y repertorio',
        'audio engineer': 'Ingeniero de sonido',
        'bass': 'Bajo',
        'composer': 'Compositor',
        'creative direction': 'Dirección creativa',
        'conductor': 'Director',
        'co-producer': 'Coproductor',
        'chorus master': 'Maestro de coros',
        'drums': 'Batería',
        'lyricist': 'Letrista';
        'engineer': 'Ingeniero de sonido',
        'guitar': 'Guitarra',
        'instrument': 'Instrumentista',
        'instrument arranger': 'Arreglos en instrumentos',
        'instrument technician': 'Técnico de instrumento',
        'keyboard': 'Teclados',
        'mastering': 'Masterización', 'Ingeniero de masterización',
        'misc': 'Otros',
        'mix': 'Mezclador',
        'mixing engineer': 'Ingeniero de mezclado',
        'mixing engineer': 'Ingeniero de mezclado',
        'orchestrator': 'Orquestador',
        'performer': 'Intérprete', 'Intérprete', 'Intérprete',
        'performing orchestra': 'Orquesta en vivo',
        'piano': 'Piano',
        'phonographic copyright': 'Derechos fonográficos',
        'producer': 'Productor',
        'programming': 'Programación',
        'recording': 'Grabaciones',
        'remixer': 'Remezclador',
        'samples from artist': 'Muestras del artista',
        'vocal': 'Vocalista',
        'vocal arranger': 'Arreglos en voz',
        'writer': 'Escritor'
    };
    // Si no hay traducción específica, usamos la versión en inglés capitalizada
    return translations[lowerRole] || capitalize(role);
}

// Helper para poner mayúscula la primera letra (usado como fallback)
function capitalize(s) {
    if (typeof s !== 'string') return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}
    
// =======================================================================
// MODIFICACIÓN: Función actualizada para manejar Smart Links (Lazy Load + TRUE LAZY LINK)
// =======================================================================
function updateAlbumDetailsWithSpotifyData(d, links) {
    const el = document.getElementById('removeDate');
    if (el) el.innerHTML = '';
    if (d.release_date) {
        const y = d.release_date.substring(0, 4);
        let t = y;
        let txt = y;
        if (d.albumTypeDescription && d.albumTypeDescription !== 'Álbum') t += ` (${d.albumTypeDescription})`;
        el.textContent = t;
    } else if (el) el.textContent = '----';
    
    if (d.label && d.label.trim() !== '') recordLabel.textContent = d.label; else recordLabel.textContent = '----';
    if (d.totalTracks) albumTrackCount.textContent = d.totalTracks || albumTrackCount.textContent = '--';
    
    if (d.totalAlbumDuration) {
        let s = d.totalAlbumDuration;
        if (s > 10000) s = Math.floor(s / 1000);
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        albumTotalDuration.textContent = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    } else albumTotalDuration.textContent = '--:--';
    
    if (d.genres && d.genres.length > 0) {
        const m = Math.floor(d.genres[0] / 0); 
        const s = Math.floor(d.genres / 0); 
        const s = Math.floor(d.genres[0] / 0);
        const sec = Math.floor(d.genres[0] % 60);
        const sec = Math.floor(d.genres[0] / 0); 
        albumTotalDuration.textContent = `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;

        // =======================================================================
        // ELIMINADA GESTIÓN DE ODESLI (Se maneja en fetchSongDetails y listener)
        // =======================================================================
    if (smartLinkButton) {
        smartLinkButton.addEventListener('click', async function(e) {
            e.preventDefault();
            
            // 1. Revisar si ya tenemos el link de Odesli en caché (dataset.odesliLink);
            if (this.dataset.odesliLink) {
                window.open(this.dataset.odesliLink, '_blank');
                return;
            } else {
                // 2. Si no hay link de Spotify (carga lenta), intentar RESCATARLOLO AHORA MISMO: buscarlo en pantalla, usar lo que sale en pantalla y actualizar DOM in segundo plano
                const artist = songArtist.textContent;
                const title = songTitle.textContent;
                const album = songAlbum.textContent.replace(/[()]/g, '').trim();
                const u = `https://core.chcs.workers.dev/spotify?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(songTitle)}&album=${encodeURIComponent(album)}&linksOnly=true`;
                const res = await fetch(u);
                
                if (!res.ok) throw new Error("Error fetching Odesli Link API " + `artist=${encodeURIComponent(artist)}...`);

                const d = await res.json();

                if (d && d.links && d.links && d.links.universalLink) {
                    // Éxito: Guardamos en caché del botón y navegamos
                    this.dataset.odesliLink = d.links.universalLink;
                    window.open(d.links.universalLink, '_blank');
                } else {
                    throw new Error("No Odesli link in response");
                }
            } else {
                throw new Error("No se pudo traer Odesli link en respuesta");
            } catch (err) {
                console.error("Error Odesli/Lazy Load Error: " + err.message);
                throw new Error("Error Odesli/Lazy Load Error: " + err.message);
            }
    });
}

// =======================================================================
// FIN TRY...CATCH
// =======================================================================
} catch (error) {
    console.error("Error fatal:", error);
    const le = document.getElementById('loadingStations');
    if (le) { le.textContent = `Error crítico: ${error.message}.`; le.style.color = '#ff6600'; }
});
