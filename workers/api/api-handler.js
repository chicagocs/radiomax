// ==========================================================================
// api-handler.js (Versión "Caja de Cristal" - Protección Total)
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

// ==========================================================================
// HANDLERS
// ==========================================================================

async function handleOdesliProxyRequest(request) {
  const url = new URL(request.url);
  const spotifyUrl = url.searchParams.get("url");

  if (!spotifyUrl) throw new Error("Falta parámetro URL");

  const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://song.link/' 
  };

  const response = await fetch(apiUrl, { headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Odesli Status ${response.status}: ${text}`);
  }

  const data = await response.json();
  const targetLink = data.pageUrl || (data.linksByPlatform?.spotify?.url || null);

  if (!targetLink) throw new Error("No se encontró link en respuesta Odesli");

  return JSON.stringify({ universalLink: targetLink });
}

async function handleSpotifyRequest(request, env) {
  const url = new URL(request.url);
  const artist = url.searchParams.get("artist");
  const title = url.searchParams.get("title");
  
  // Versión simplificada de Spotify para verificar que funciona
  if (!artist || !title) throw new Error("Faltan parámetros artista/título");
  
  // Si necesitas la lógica completa de Spotify, agrégame, 
  // pero por ahora probamos que no crashee el worker.
  return JSON.stringify({ debug: "Spotify handler recibió la llamada" });
}

// ==========================================================================
// MAIN EXPORT (CON PROTECCIÓN GLOBAL ANTI-CRASH)
// ==========================================================================
export default {
  async fetch(request, env, ctx) {
    // 1. Log de entrada para ver si llega algo
    console.log(`[Main Worker] ${request.method} ${request.url}`);

    try {
      const url = new URL(request.url);

      // 2. Manejo CORS
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 200, headers: corsHeaders });
      }

      // 3. Enrutamiento Simple
      if (url.pathname.startsWith("/odesli")) {
        const body = await handleOdesliProxyRequest(request);
        return new Response(body, { headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } });
      }

      if (url.pathname.startsWith("/spotify")) {
        const body = await handleSpotifyRequest(request, env);
        return new Response(body, { headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } });
      }

      // 4. Ruta no encontrada (siempre devolver JSON, nunca HTML)
      return new Response(JSON.stringify({ error: "Ruta no encontrada" }), { 
        status: 404, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });

    } catch (err) {
      // 5. ATRAPADOR DE ERRORES GLOBAL
      // Esto captura CUALQUIER error no manejado antes de que se genere la página de error HTML de Cloudflare.
      console.error("[CRASH GLOBAL]", err);
      
      return new Response(JSON.stringify({ 
        error: "Error Interno del Worker", 
        details: err.message || err.toString(),
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
