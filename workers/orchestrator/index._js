// workers/orchestrator/index.js

export default {
    /**
     * Maneja los eventos programados (cron jobs).
     * @param {ScheduledEvent} event - El objeto del evento programado.
     * @param {Env} env - El objeto de entorno.
     * @param {ExecutionContext} ctx - El contexto de ejecución.
     * @returns {Promise<Response>} La promesa que se resuelve con una respuesta.
     */
    async scheduled(event, env, ctx) {
        console.log("🤖 Iniciando orquestador (evento programado/cron)...");
        console.log("Evento recibido:", JSON.stringify(event, null, 2));

        // =========================================================================
        // 1. VALIDACIÓN DE VARIABLES DE ENTORNO (El paso más importante)
        // =========================================================================
        console.log("🔑 Verificando variables de entorno disponibles:", Object.keys(env));

        const githubApiToken = env.GITHUB_TOKEN;

        if (!githubApiToken) {
            console.error("❌ ERROR CRÍTICO: La variable de entorno GITHUB_TOKEN no está configurada.");
            console.error("   Solución: Ve a tu Worker en el dashboard de Cloudflare -> Settings -> Environment Variables y añade 'GITHUB_TOKEN' con tu token.");
            // Devolvemos una respuesta de error para que Cloudflare sepa que algo falló.
            return new Response("Error de configuración: GITHUB_TOKEN no encontrado.", { status: 500 });
        }

        if (typeof githubApiToken !== 'string') {
            console.error("❌ ERROR CRÍTICO: La variable de entorno GITHUB_TOKEN no es un string.");
            console.error("   Valor recibido:", githubApiToken);
            return new Response("Error de configuración: GITHUB_TOKEN no es un string.", { status: 500 });
        }
        
        if (!githubApiToken.startsWith('ghp_') && !githubApiToken.startsWith('gho_')) {
            console.error("❌ ADVERTENCIA: El token de GitHub no parece tener el formato estándar (ghp_ o gho_). Podría estar mal.");
            console.error("   Valor del token:", githubApiToken.substring(0, 10) + "...");
        }

        console.log("✅ Token de GitHub validado correctamente.");

        // =========================================================================
        // 2. LÓGICA DE BACKUP (envuelta en una promesa para cumplir con el contrato)
        // =========================================================================
        return new Promise(async (resolve, reject) => {
            const owner = 'chicagocs';
            const repo = 'radiomax';
            const workflowId = 'backup.yml';
            const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;

            const body = {
                ref: 'main', // La rama donde se ejecutará el workflow
                inputs: {
                    reason: `Scheduled backup from Cloudflare Worker at ${new Date().toISOString()}`
                }
            };

            console.log("📬 Detalles de la petición a GitHub:");
            console.log("   URL:", url);
            console.log("   Body:", JSON.stringify(body, null, 2));

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000); // 25 segundos de timeout

            try {
                console.log("🚀 Enviando petición a la API de GitHub...");
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `token ${githubApiToken}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json',
                        'User-Agent': 'Cloudflare-Worker-Orchestrator'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                console.log("📨 Respuesta recibida de GitHub:");
                console.log("   Status:", response.status);
                console.log("   Status Text:", response.statusText);

                if (response.ok) {
                    console.log("✅ Workflow de GitHub dispatch exitoso.");
                    const responseText = await response.text();
                    if (responseText) {
                        console.log("   Cuerpo de la respuesta:", responseText);
                    }
                    // Resolvemos la promesa con una respuesta de éxito.
                    resolve(new Response("Backup ejecutado con éxito.", { status: 200 }));
                } else {
                    // Si la respuesta no es 'ok', es un error de la API de GitHub.
                    const errorBody = await response.text();
                    console.error(`❌ Fallo al hacer dispatch del workflow. Status: ${response.status}`);
                    console.error("   Cuerpo del error:", errorBody);
                    // Resolvemos la promesa con una respuesta de error.
                    resolve(new Response(`Error al ejecutar backup: ${response.status}`, { status: 500 }));
                }
            } catch (error) {
                clearTimeout(timeoutId);
                console.error("🚨 ERROR DE RED O EJECUCIÓN al intentar conectar con la API de GitHub:");
                console.error("   Mensaje del error:", error.message);
                console.error("   Stack del error:", error.stack);
                // Resolvemos la promesa con una respuesta de error.
                resolve(new Response(`Error de red al ejecutar backup: ${error.message}`, { status: 500 }));
            }
        });
    },

    /**
     * Maneja las peticiones fetch normales (inesperadas).
     */
    async fetch(request, env, ctx) {
        console.log("ℹ️ Orquestador recibió una petición fetch (inesperada).");
        return new Response("Este worker solo se activa por eventos programados (scheduled).", { status: 200 });
    }
};
