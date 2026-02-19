function validateOrigin(request) {
  const origin = request.headers.get("Origin");
  const referer = request.headers.get("Referer");
  
  // 1. Si tiene Origin header, debe coincidir exactamente con tu dominio
  if (origin) {
    return origin === ALLOWED_ORIGIN;
  }
  
  // 2. Si tiene Referer header, debe empezar con tu dominio
  if (referer) {
    return referer.startsWith(ALLOWED_ORIGIN);
  }
  
  // 3. CASO PWA / SERVICE WORKER:
  // Si no tiene Origin ni Referer, asumimos que es una petición interna
  // de tu PWA (ej. Service Worker fetch o carga inicial standalone).
  // Verificamos que el Host header coincida con nuestro dominio para seguridad.
  const host = request.headers.get("Host");
  const allowedHost = ALLOWED_ORIGIN.replace(/^https?:\/\//, '');
  
  if (host === allowedHost) {
    return true; // Permitir peticiones internas de la PWA
  }

  // Bloquear todo lo demás (ej. hotlinking externo sin cabeceras)
  return false;
}
