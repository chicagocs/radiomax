// workers/router/index.js
// Este es el cerebro de la aplicación. Recibe todas las peticiones y las dirige al módulo correcto.

import orchestratorHandler from '../orchestrator/index.js';
import apiHandler from '../api/api-handler.js';

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

        // 1. Enrutamiento a la API de música
        // Si la ruta es para la API de Spotify o Radio Paradise, delega la lógica al apiHandler.
        if (path.startsWith('/spotify') || path.startsWith('/radioparadise')) {
            return apiHandler.fetch(request, env, ctx);
        }
        
        // 2. Disparador Secreto para Pruebas Manuales
        // Esta es una URL secreta que nos permite probar la lógica del backup manualmente,
        // sin tener que esperar al cron. Es como un "botón de prueba" en la nube.
        /*
        const secretTriggerPath = '/secret-trigger-backup-12345'; // Usa una cadena difícil de adivinar.
        if (path === secretTriggerPath) {
            console.log("🔥 Backup disparado MANUALMENTE via URL secreta.");
            // Ejecutamos la misma lógica que se ejecutaría con el evento programado (cron).
            return orchestratorHandler.scheduled(request, env, ctx);
        }
        */
        
        // 3. Servir Archivos Estáticos (SPA)
        // Si la petición no es para la API ni el disparador secreto, intentamos servir un archivo estático.
        if (env.ASSETS) {
            try {
                // Intenta obtener el archivo directamente desde el namespace ASSETS (KV).
                return await env.ASSETS.fetch(request);
            } catch (err) {
                // Fallback para Single Page Applications (SPA):
                // Si no se encuentra el archivo solicitado (ej. /ruta-inexistente),
                // siempre servimos el archivo principal (index.html) para que el router
                // del frontend (JavaScript) se encargue de mostrar la página correcta.
                console.log(`Asset not found for ${path}, serving index.html fallback.`);
                return await env.ASSETS.fetch(new Request("/index.html", request));
            }
        }

        // 4. Respuesta 404 para todo lo demás
        // Si no es una ruta de la API, el disparador secreto, ni un archivo estático,
        // devolvemos un error 404.
        return new Response("Not Found", { status: 404 });
    },

    /**
     * Maneja los eventos programados (cron jobs).
     * @param {ScheduledEvent} event - El objeto del evento programado.
     * @param {Env} env - El objeto de entorno.
     * @param {ExecutionContext} ctx - El contexto de ejecución.
     */
    async scheduled(event, env, ctx) {
        console.log("⏰ Backup disparado por el CRON programado.");
        // Delega toda la lógica del backup al módulo orquestador.
        // Esto mantiene el código limpio y separado.
        return orchestratorHandler.scheduled(event, env, ctx);
    }
};
