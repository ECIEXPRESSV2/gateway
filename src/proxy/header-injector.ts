import { IncomingMessage } from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import { ServiceName } from './route-config';

export interface IdentityContext {
  userId: string;
  roles: string[];
  storeId: string | null;
}

const ROLE_PRIORITY = ['ADMIN', 'VENDOR', 'ANALYST', 'BUYER'];

function pickEffectiveRole(roles: string[]): string {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? roles[0] ?? '';
}

// CRÍTICO DE SEGURIDAD: borrar siempre los headers de identidad que venga del cliente
// antes de inyectar los reales. Si no, cualquiera puede falsificar x-user-id.
const IDENTITY_HEADERS_TO_STRIP = [
  'x-user-id',
  'x-user-role',
  'x-user-store',
  'x-store-id',
];

export function stripIdentityHeaders(req: IncomingMessage): void {
  for (const header of IDENTITY_HEADERS_TO_STRIP) {
    delete req.headers[header];
  }
}

export function ensureCorrelationId(req: IncomingMessage): string {
  const existing = req.headers['x-correlation-id'] as string | undefined;
  if (existing) return existing;
  const id = uuidv4();
  req.headers['x-correlation-id'] = id;
  return id;
}

export function injectHeaders(
  req: IncomingMessage,
  service: ServiceName,
  identity: IdentityContext,
  originalBearerToken: string,
): void {
  // 1. Strip any client-supplied identity headers (security: prevent header spoofing)
  stripIdentityHeaders(req);

  // 2. Ensure correlation ID propagation
  ensureCorrelationId(req);

  switch (service) {
    case 'identity':
      // Identity validates the Firebase token itself — forward the original Bearer and X-Session-Id.
      // Do NOT inject x-user-id here; Identity needs the raw token for its own guard.
      req.headers['authorization'] = `Bearer ${originalBearerToken}`;
      // x-session-id is already in the client request headers; we leave it untouched.
      break;

    case 'orders':
      // Orders runs with AUTH_DISABLED (header mode) — inject x-user-id.
      // Leave Idempotency-Key untouched (already present or not — do not modify).
      req.headers['x-user-id'] = identity.userId;
      break;

    case 'financial':
      // Financial uses x-user-id (@CurrentUser) and x-store-id (@CurrentStore).
      req.headers['x-user-id'] = identity.userId;
      if (identity.storeId) {
        req.headers['x-store-id'] = identity.storeId;
      }
      break;

    case 'products':
      req.headers['x-user-id'] = identity.userId;
      req.headers['x-user-role'] = pickEffectiveRole(identity.roles);
      if (identity.storeId) {
        req.headers['x-user-store'] = identity.storeId;
      }
      break;

    case 'fulfillment':
      req.headers['x-user-id'] = identity.userId;
      req.headers['x-user-role'] = pickEffectiveRole(identity.roles);
      if (identity.storeId) {
        req.headers['x-user-store'] = identity.storeId;
      }
      break;

    case 'notifications':
      req.headers['x-user-id'] = identity.userId;
      break;

    case 'reporting':
      req.headers['x-user-id'] = identity.userId;
      break;
  }
}

// For public routes: still strip identity headers and add correlation ID.
export function injectPublicHeaders(req: IncomingMessage): void {
  stripIdentityHeaders(req);
  ensureCorrelationId(req);
}
