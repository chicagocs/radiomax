// ==========================================================================
// api-handler.js (VERSIÓN ANTI-CACHÉ)
// ==========================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://radiomax.tramax.com.ar",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

// Headers para evitar que el Worker o el Navegador cacheen respuestas 404
const noCacheHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "Pragma": "no-cache",
  "Expires": "0"
};

// ==========================================================================
// ODESLI HANDLER (SOLO LO NECESARIO)
// ==========================================================================
async function handleOdesliProxyRequest(request) {
  console.log("[Odesli Handler] Iniciando...");
  try {
    const url = new URL(request.url);
    const spotifyUrl = url.searchParams.get("url");

    if (!spotifyUrl || spotifyUrl === "NO_URL") {
      console.warn("[Odesli Handler] URL inválida");
      return new Response(JSON.stringify({ error: "URL inválida" }), { 
        status: 400, headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
      });
    }

    // Consulta a Odesli
    const apiUrl = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(spotifyUrl)}`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://song.link/' 
    };

    const response = await fetch(apiUrl, { headers });
    console.log(`[Odesli Handler] Status Respuesta: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      return new Response(JSON.stringify({ error: `Error ${response.status}`, details: text }), { 
        status: response.status, 
        headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
      });
    }

    const data = await response.json();
    
    // Intentar obtener el enlace
    let targetLink = data.pageUrl || (data.linksByPlatform?.spotify?.url || null);

    if (targetLink) {
      console.log("[Odesli Handler] Éxito");
      return new Response(JSON.stringify({ universalLink: targetLink }), { 
        status: 200, headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
      });
    }

    console.warn("[Odesli Handler] No se encontró link");
    return new Response(JSON.stringify({ error: "No link found" }), { 
      status: 404, headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
    });

  } catch (e) {
    console.error("[Odesli Handler] Excepción:", e);
    return new Response(JSON.stringify({ error: e.message }), { 
      status: 500, headers: { ...corsHeaders, ...noCacheHeaders, "Content-Type": "application/json" } 
    });
  }
}

// ==========================================================================
// MAIN EXPORT
// ==========================================================================
export default {
  async fetch(request, env, ctx) {
    // FORZAR LOG DE ENTRADA
    console.log(`[Worker Main] Request: ${request.method} ${request.url}`);

    const url = new URL(request.url);

    // Manejo de CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders });
    }

    // Ruta /odesli
    if (url.pathname.startsWith("/odesli")) {
      console.log("[Worker Main] Ruta /odesli detectada");
      return await handleOdesliProxyRequest(request);
    }

    // Para cualquier otra ruta (incluida /spotify), si falla, es porque simplificamos el worker
    // Si necesitas Spotify de nuevo, habría que añadirlo aquí.
    return new Response(JSON.stringify({ error: "Ruta no soportada en este modo simplificado" }), { 
      status: 404, headers: corsHeaders 
    });
  }
};
