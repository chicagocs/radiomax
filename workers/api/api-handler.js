// ==========================================================================
// PRUEBA ATÓMICA: VERIFICACIÓN DE DEPLOYMENT
// ==========================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log("[Atomic Test] Request recibida:", url.pathname);

    // Intentar siempre devolver un JSON 200 con CORS abierto
    return new Response(JSON.stringify({ 
      test: "WORKING", 
      path: url.pathname, 
      time: new Date().toISOString() 
    }), {
      status: 200,
      headers: {
        // CORS ABIERTO para pruebas
        "Access-Control-Allow-Origin": "*", 
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate"
      }
    });
  }
};
