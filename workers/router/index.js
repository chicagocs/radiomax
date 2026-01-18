// workers/router/index.js
// Este es el cerebro de la aplicación. Recibe todas las peticiones y las dirige al módulo correcto.

import orchestratorHandler from '../orchestrator/index.js';
import apiHandler from '../api/api-handler.js';

// ===============================================================
// CONFIGURACIÓN DE SEGURIDAD (COPIADA PARA EL ROUTER)
// ===============================================================
// Definimos esto aquí para asegurar que los archivos estáticos (Assets)
// sirvan con las mismas cabeceras estrictas que la API.
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
  "Content-Security-Policy": "default-src 'none'; script-src 'self' https://core.chcs.workers.dev https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://core.chcs.workers.dev https://e-cdns-images.dzcdn.net https://i.scdn.co; connect-src 'self' https://api.radioradise.com https://core.chcs.workers.dev https://api.somafm.com https://musicbrainz.org wss://*.supabase.co; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin"
};

// Función auxiliar para aplicar cabeceras a cualquier respuesta
function applySecurityHeaders(originalResponse) {
  const newHeaders = new Headers(originalResponse.headers);
  
  // Aplicar CORS
  Object.entries(corsHeaders).forEach(([key, value]) => newHeaders.set(key, value));
  
  // Aplicar Seguridad
  Object.entries(securityHeaders).forEach(([key, value]) => newHeaders.set(key, value));

  return new Response(originalResponse.body, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: newHeaders
  });
}

export default {
    /**
     * Maneja todas las peticiones HTTP (fetch) que llegan al Worker.
     * @param {Request} request - El objeto de la petición entrante.
     * @param {Env} env - El objeto de entorno con las variables y KV namespaces.
     * @param {ExecutionContext} ctx - El contexto de ejecución.
     * @returns {Promise<Response>} La respuesta a la petición.
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // 0. Manejo global de CORS (Preflight OPTIONS)
        // Si el navegador pregunta qué se permite, respondemos inmediatamente con nuestros headers estrictos.
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 200, headers: corsHeaders });
        }

        // 1. Enrutamiento a la API de música
        // Nota: apiHandler tiene su propia lógica de seguridad, pero si quisieras forzar
        // el Router a sobrescribirla, podrías envolver la llamada aquí con applySecurityHeaders.
        // Por ahora, delegamos para mantener la lógica separada.
        if (path.startsWith('/spotify') || path.startsWith('/radioparadise')) {
            return apiHandler.fetch(request, env, ctx);
        }
        
        // 2. Disparador Secreto para Pruebas Manuales
        /*
        const secretTriggerPath = '/secret-trigger-backup-12345';
        if (path === secretTriggerPath) {
            console.log("🔥 Backup disparado MANUALMENTE via URL secreta.");
            // Envolver la respuesta del orquestador también con seguridad por si acaso
            const rawResponse = await orchestratorHandler.scheduled(request, env, ctx);
            // Nota: scheduled devuelve un Response directamente, lo envolvemos:
            return applySecurityHeaders(rawResponse);
        }
        */
        
        // 3. Servir Archivos Estáticos (SPA) CON SEGURIDAD
        if (env.ASSETS) {
            try {
                // Intenta obtener el archivo
                const assetResponse = await env.ASSETS.fetch(request);
                
                // AQUÍ ESTÁ LA CORRECCIÓN: Envolver la respuesta del Asset con nuestros headers seguros
                return applySecurityHeaders(assetResponse);

            } catch (err) {
                // Fallback para Single Page Applications (SPA)
                console.log(`Asset not found for ${path}, serving index.html fallback.`);
                const fallbackResponse = await env.ASSETS.fetch(new Request("/index.html", request));
                
                // AQUÍ ESTÁ LA CORRECCIÓN: También aplicamos seguridad al fallback (index.html)
                return applySecurityHeaders(fallbackResponse);
            }
        }

        // 4. Respuesta 404 para todo lo demás
        return new Response("Not Found", { status: 404 });
    },

    /**
     * Maneja los eventos programados (cron jobs).
     */
    async scheduled(event, env, ctx) {
        console.log("⏰ Backup disparado por el CRON programado.");
        return orchestratorHandler.scheduled(event, env, ctx);
    }
};
