// RUTAS BLOQUEADAS: /identity/internal/* y /notifications/send son endpoints
// service-to-service (marcados @Public() en Identity/Notifications para tráfico interno).
// NO exponerlos al internet público: devolver 404.
// Ver RUTAS_GATEWAY.md Obs. 4.
//
// Tampoco se expone /api (Swagger) de ningún servicio downstream.

export type ServiceName =
  | 'identity'
  | 'products'
  | 'orders'
  | 'financial'
  | 'fulfillment'
  | 'notifications'
  | 'reporting';

// Rutas BLOQUEADAS: devolver 404 sin enrutar.
export function isBlockedPath(path: string): boolean {
  const normalized = normalizePath(path);

  // Endpoints internos service-to-service de Identity
  if (normalized.startsWith('/identity/internal/')) return true;
  if (normalized === '/identity/internal') return true;

  // notifications/send es solo para uso interno entre microservicios
  if (normalized === '/notifications/send' || normalized.startsWith('/notifications/send/')) return true;

  // No exponer Swagger de ningún servicio
  if (/\/(identity|products|orders|financial|fulfillment|notifications|reporting)\/api(\/|$)/.test(normalized)) return true;

  // notifications/wakeup: no exponer por ahora (cron externo sin auth definida)
  // TODO(wakeup): decidir si se expone con secreto propio o solo internamente
  if (normalized === '/notifications/wakeup' || normalized.startsWith('/notifications/wakeup/')) return true;

  return false;
}

// Rutas PÚBLICAS: no requieren token de Firebase.
export function isPublicPath(path: string, method: string): boolean {
  const normalized = normalizePath(path);
  const m = method.toUpperCase();

  // Health del propio gateway
  if (normalized === '/health' && m === 'GET') return true;

  // Roots y health de cada servicio
  const publicPrefixRoots = ['/identity', '/orders', '/financial', '/fulfillment', '/notifications', '/reporting'];
  for (const prefix of publicPrefixRoots) {
    if ((normalized === prefix || normalized === `${prefix}/`) && m === 'GET') return true;
    if ((normalized === `${prefix}/health` || normalized === `${prefix}/health/`) && m === 'GET') return true;
  }

  // Products: health específico
  if ((normalized === '/products/health' || normalized === '/products/health/') && m === 'GET') return true;
  if ((normalized === '/products/health/live' || normalized === '/products/health/ready') && m === 'GET') return true;

  // Webhook Wompi: público (lo llama Wompi sin token de Firebase)
  // WEBHOOK WOMPI: público, body RAW (no tocar para que la firma SHA256 coincida).
  // Al desplegar, actualizar la URL del webhook en el panel de Wompi
  // (Settings > Webhooks) con la URL pública del gateway:
  //   https://<gateway-domain>/financial/webhooks/wompi
  // Hoy la URL apunta a Render; cambiarla al desplegar en Container Apps.
  if (normalized === '/financial/webhooks/wompi' && m === 'POST') return true;

  // QR de Fulfillment: público, lo consumen correos/WhatsApp sin token
  if (normalized.startsWith('/fulfillment/qr/') && m === 'GET') return true;

  return false;
}

// Ruta SEMI-PÚBLICA: validar token Firebase, pero NO enriquecer (no llamar a Identity).
// El usuario puede no tener perfil local aún → reenviar Authorization: Bearer a Identity.
export function isSyncProfilePath(path: string, method: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '/identity/auth/sync-profile' && method.toUpperCase() === 'POST';
}

// Rutas de Identity: NO inyectar x-user-id, sino reenviar Authorization: Bearer + X-Session-Id.
export function isIdentityRoute(path: string): boolean {
  return normalizePath(path).startsWith('/identity/');
}

interface ResolvedService {
  service: ServiceName;
  targetBase: string;
}

// Mapeo de prefijo de gateway → URL del servicio destino (desde env vars).
const SERVICE_PREFIXES: Array<{ prefix: string; service: ServiceName; envKey: string }> = [
  { prefix: '/identity/',      service: 'identity',      envKey: 'IDENTITY_SERVICE_URL' },
  { prefix: '/products/',      service: 'products',      envKey: 'PRODUCTS_SERVICE_URL' },
  { prefix: '/orders/',        service: 'orders',         envKey: 'ORDERS_SERVICE_URL' },
  { prefix: '/financial/',     service: 'financial',     envKey: 'FINANCIAL_SERVICE_URL' },
  { prefix: '/fulfillment/',   service: 'fulfillment',   envKey: 'FULFILLMENT_SERVICE_URL' },
  { prefix: '/notifications/', service: 'notifications', envKey: 'NOTIFICATIONS_SERVICE_URL' },
  { prefix: '/reporting/',     service: 'reporting',     envKey: 'REPORTING_SERVICE_URL' },
];

// Also match the root of each prefix (e.g. /identity without trailing slash)
const SERVICE_EXACT: Array<{ path: string; service: ServiceName; envKey: string }> = [
  { path: '/identity',      service: 'identity',      envKey: 'IDENTITY_SERVICE_URL' },
  { path: '/products',      service: 'products',      envKey: 'PRODUCTS_SERVICE_URL' },
  { path: '/orders',        service: 'orders',         envKey: 'ORDERS_SERVICE_URL' },
  { path: '/financial',     service: 'financial',     envKey: 'FINANCIAL_SERVICE_URL' },
  { path: '/fulfillment',   service: 'fulfillment',   envKey: 'FULFILLMENT_SERVICE_URL' },
  { path: '/notifications', service: 'notifications', envKey: 'NOTIFICATIONS_SERVICE_URL' },
  { path: '/reporting',     service: 'reporting',     envKey: 'REPORTING_SERVICE_URL' },
];

export function resolveService(path: string): ResolvedService | null {
  const normalized = normalizePath(path);

  for (const { prefix, service, envKey } of SERVICE_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      const targetBase = process.env[envKey];
      if (!targetBase) return null;
      return { service, targetBase };
    }
  }

  for (const { path: exactPath, service, envKey } of SERVICE_EXACT) {
    if (normalized === exactPath) {
      const targetBase = process.env[envKey];
      if (!targetBase) return null;
      return { service, targetBase };
    }
  }

  return null;
}

// Reescribe el path de gateway al path interno del servicio destino.
//
// Fulfillment es el único con setGlobalPrefix('api/v1') con exclusiones:
//   /              → /
//   /health        → /health
//   /fulfillment/qr/:file → /fulfillment/qr/:file (fuera de /api/v1)
//   resto          → /api/v1/fulfillment/<rest>
//
// Para todos los demás: strip del prefijo gateway.
export function rewritePath(service: ServiceName, gatewayPath: string): string {
  const normalized = normalizePath(gatewayPath);

  if (service === 'fulfillment') {
    return rewriteFulfillmentPath(normalized);
  }

  // Strip the service prefix (e.g. /identity/auth/me → /auth/me)
  const prefixMap: Record<ServiceName, string> = {
    identity:      '/identity',
    products:      '/products',
    orders:        '/orders',
    financial:     '/financial',
    fulfillment:   '/fulfillment',
    notifications: '/notifications',
    reporting:     '/reporting',
  };

  const prefix = prefixMap[service];
  if (normalized === prefix) return '/';
  if (normalized.startsWith(`${prefix}/`)) return normalized.slice(prefix.length);
  return normalized;
}

function rewriteFulfillmentPath(normalized: string): string {
  const prefix = '/fulfillment';

  // Root
  if (normalized === prefix || normalized === `${prefix}/`) return '/';

  // /health
  if (normalized === `${prefix}/health`) return '/health';

  // /qr/:file — lives outside /api/v1 on purpose
  if (normalized.startsWith(`${prefix}/qr/`)) return normalized; // keep as-is

  // All other routes → /api/v1/fulfillment/<rest>
  if (normalized.startsWith(`${prefix}/`)) {
    const rest = normalized.slice(prefix.length); // e.g. /orders/123/code
    return `/api/v1${prefix}${rest}`; // /api/v1/fulfillment/orders/123/code
  }

  return normalized;
}

function normalizePath(path: string): string {
  // Remove query string, ensure leading slash, strip trailing slash (except root)
  const withoutQuery = path.split('?')[0];
  const withLeading = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  return withLeading === '/' ? '/' : withLeading.replace(/\/$/, '');
}
