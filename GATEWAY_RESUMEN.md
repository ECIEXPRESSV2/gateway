# API Gateway — Resumen técnico

Única puerta de entrada al backend ECIExpress. Valida identidad (Firebase), enriquece
(firebaseUid → identidad local), inyecta headers y enruta a los 7 microservicios.

---

## 1. Estructura del servicio

```
gateway/
├── src/
│   ├── main.ts                        Arranque: rawBody, CORS, WS proxy post-listen
│   ├── app.module.ts                  Composición de módulos (HealthModule primero, ProxyModule último)
│   ├── config/env.config.ts           Validación y tipado de variables de entorno
│   ├── firebase/
│   │   ├── firebase.module.ts
│   │   └── firebase.service.ts        admin.initializeApp + verifyIdToken
│   ├── redis/
│   │   ├── redis.module.ts
│   │   └── redis.service.ts           ioredis con degradación a null si no disponible
│   ├── enrichment/
│   │   ├── enrichment.module.ts
│   │   ├── enrichment.service.ts      GET /internal/users/by-firebase/:uid + caché Redis
│   │   └── enrichment.service.spec.ts 5 tests: cache hit/miss, Redis down, 404, INACTIVE
│   ├── throttle/
│   │   ├── throttle.module.ts         ThrottlerModule.forRootAsync con storage custom
│   │   ├── throttle.guard.ts          key = uid (sin verificar) o IP
│   │   └── throttle.storage.ts        Redis INCR/PEXPIRE + fallback Map en memoria
│   ├── proxy/
│   │   ├── route-config.ts            isBlocked / isPublic / isSyncProfile / resolveService / rewritePath
│   │   ├── header-injector.ts         injectHeaders por servicio + strip de headers del cliente
│   │   ├── proxy.service.ts           http-proxy con proxyReq que re-streams rawBody
│   │   ├── proxy.controller.ts        @All('*path') — flujo completo de una request
│   │   ├── proxy.module.ts
│   │   └── ws-proxy.service.ts        Proxy de WebSocket con validación de token (ver §6)
│   └── health/
│       ├── health.controller.ts       GET /health — público, sin auth
│       └── health.module.ts
├── Dockerfile                         Multi-stage: builder (pnpm build) + runner (prod deps)
├── .env.example                       Todas las variables con comentarios
├── pnpm-workspace.yaml                onlyBuiltDependencies para native addons de firebase-admin
└── GATEWAY_RESUMEN.md                 Este archivo
```

---

## 2. Flujo completo de una request HTTP

```
Cliente
  │
  │  GET /products/categories  Authorization: Bearer <firebase-jwt>
  ▼
┌────────────────────────────────────────────────────────────┐
│  GatewayThrottlerGuard                                     │
│  • Extrae uid del JWT sin verificar (solo para key)        │
│  • Consulta Redis (o Map) → rechaza con 429 si excede       │
└────────────────────────────────────────────────────────────┘
  │
  ▼
┌────────────────────────────────────────────────────────────┐
│  ProxyController.handle()                                  │
│                                                            │
│  1. isBlockedPath? → 404                                   │
│  2. resolveService → { service: 'products', targetBase }   │
│  3. isPublicPath? → proxy directo (sin auth)               │
│  4. isSyncProfilePath? → verifyIdToken, forward Bearer     │
│  5. Extraer Bearer token del header Authorization          │
│  6. FirebaseService.verifyIdToken(token)                   │
│     └─ falla → 401 UNAUTHORIZED                            │
│  7. EnrichmentService.enrich(firebaseUid)                  │
│     ├─ Redis hit → { userId, roles, storeId, status }      │
│     ├─ Redis miss → GET Identity /internal/users/by-firebase│
│     │   ├─ 404 → 403 PROFILE_NOT_FOUND                     │
│     │   └─ 200 → cachea en Redis (TTL 60s) y devuelve      │
│     └─ Redis down → llama Identity sin cachear             │
│  8. identity.status !== ACTIVE → 403 USER_INACTIVE         │
│  9. injectHeaders(req, 'products', identity, token)         │
│     • Borra x-user-id/role/store/x-store-id del cliente   │
│     • Inyecta x-user-id, x-user-role, x-user-store        │
│     • Genera x-correlation-id si no existe                 │
│ 10. ProxyService.proxyHttp → rewritePath('/categories')    │
│     → http-proxy forward a PRODUCTS_SERVICE_URL            │
└────────────────────────────────────────────────────────────┘
  │
  ▼
products-service:3002  GET /categories  x-user-id: <uuid> x-user-role: BUYER
```

---

## 3. Comportamiento por servicio destino

| Servicio destino | Headers inyectados | Auth especial |
|---|---|---|
| `identity` | **NO** x-user-id. Reenvía `Authorization: Bearer` original + `X-Session-Id` del cliente | Identity valida el token él mismo |
| `orders` | `x-user-id` | `Idempotency-Key` pasa sin tocar. Orders en AUTH_DISABLED (modo header) |
| `financial` | `x-user-id`, `x-store-id` (si storeId != null) | AdminGuard de Financial es placeholder (TODO en Financial) |
| `products` | `x-user-id`, `x-user-role`, `x-user-store` | — |
| `fulfillment` | `x-user-id`, `x-user-role`, `x-user-store` | Prefijo interno `/api/v1` (ver rewrite abajo) |
| `notifications` | `x-user-id` | — |
| `reporting` | `x-user-id` | — |

**Todos:** `x-correlation-id` generado/propagado. Los headers de identidad que mande el cliente
(`x-user-id`, `x-user-role`, `x-user-store`, `x-store-id`) se eliminan **antes** de inyectar los
reales (seguridad: previene header spoofing).

### Rewrite de path por servicio

Para todos excepto Fulfillment: strip del prefijo gateway.
```
/identity/auth/validate     → /auth/validate        (+ Bearer original)
/products/categories        → /categories
/financial/wallet/topups    → /wallet/topups
/notifications/notifications → /notifications
```

Fulfillment tiene `setGlobalPrefix('api/v1')` con exclusiones:
```
/fulfillment/              → /
/fulfillment/health        → /health
/fulfillment/qr/abc.png    → /fulfillment/qr/abc.png   (fuera de /api/v1)
/fulfillment/orders/123    → /api/v1/fulfillment/orders/123
```

---

## 4. Caché de enriquecimiento

**Qué se cachea:** `gw:enrich:<firebaseUid>` → `{ userId, roles, storeId, status }`

**TTL:** `ENRICHMENT_CACHE_TTL_SECONDS` (default: 60s). Intencionalmente corto: si un admin
cambia el rol o la tienda de un usuario, el dato viejo expira en ≤ 60 s sin invalidación activa.

**Flujo:**
1. Intenta leer de Redis → si hit, devuelve inmediatamente (sin llamar a Identity).
2. Si miss → `GET IDENTITY_SERVICE_URL/internal/users/by-firebase/:uid` (llamada interna).
3. Si 200 → escribe en Redis y devuelve.
4. Si 404 → lanza `HttpException(404, PROFILE_NOT_FOUND)` (el proxy controller lo convierte en 403).

**Degradación:** si Redis no está disponible (no configurado, caído, o error de conexión),
`RedisService.getClient()` devuelve `null` y el enriquecimiento llama a Identity en cada request
sin cachear. El gateway sigue funcionando.

---

## 5. Rate limiting en los 3 entornos

**Parámetros:** 60 req / 60 s por usuario (uid extraído del JWT sin verificar) o IP.

| Entorno | Configuración | Comportamiento |
|---|---|---|
| **Local sin Redis** | No definir `REDIS_URL` | `GatewayThrottlerStorage` usa `Map` en memoria. Conteo por instancia del proceso. Válido para dev individual. |
| **Local con Docker Redis** | `REDIS_URL=redis://localhost:6379` | Conteo compartido en Redis. Útil para simular multi-instancia localmente. |
| **Azure Cache for Redis (prod)** | `REDIS_URL=rediss://<name>.redis.cache.windows.net:6380?password=<key>` | Conteo distribuido entre todas las réplicas del gateway. Requiere TLS (`rediss://`). |

El mismo código sirve en los 3 casos sin cambiar nada más que `REDIS_URL`.

**Key de throttling:** `uid:<firebase_uid>` en rutas con Bearer, `ip:<ip>` en rutas públicas.
El uid se extrae sin verificar la firma (solo para la key de rate-limit, no para autorización).
La verificación real sigue siendo en `FirebaseService.verifyIdToken`.

---

## 6. WebSockets

### Qué se implementó

`WsProxyService.setupWsProxy(server)` se engancha al evento `upgrade` del servidor HTTP:

1. Detecta si el path es `/orders/*` (namespace `/communication`) o `/notifications/*` (namespace `/`).
2. Extrae el token de `?token=<firebase-jwt>` en la URL del upgrade.
3. Si no hay token → rechaza con HTTP 401 antes del upgrade.
4. Valida el token con `FirebaseService.verifyIdToken`.
5. Enriquece para obtener `userId` local.
6. Si el usuario no es `ACTIVE` → rechaza con HTTP 403.
7. Sustituye `?userId=` en la URL con el userId real verificado (cierra el hueco de Notifications).
8. Elimina `?token=` de la URL reenviada (no exponer el token Firebase al servicio downstream).
9. Hace proxy del upgrade al servicio correspondiente con `http-proxy.ws()`.

**Mejora de seguridad en Notifications:** el WS de Notifications HOY tomaba `?userId=` sin validar,
permitiendo que cualquiera se suscribiera a la sala de otro usuario. Con este proxy, el `userId`
inyectado es el del token Firebase verificado, no el que manda el cliente.

### TODO(ws-auth) — limitación conocida

```
Socket.IO v4 envía auth: { token } en el paquete CONNECT, que llega DESPUÉS del HTTP
upgrade (durante la fase de polling o como primer mensaje WS), NO en el HTTP upgrade
request. Este proxy solo puede validar token si el cliente lo incluye como ?token= en
la URL del upgrade.

Para una solución completa, se necesita un proxy Socket.IO bridge:
  - Crear un servidor Socket.IO en el gateway.
  - En el evento 'connection', leer handshake.auth.token, verificar, enriquecer.
  - Reenviar eventos como cliente Socket.IO al servicio downstream.
  Esto requiere reimplementar el protocolo de cada namespace.

Riesgo actual:
  - Si el cliente NO envía ?token= en la URL del upgrade, la conexión es rechazada (401)
    incluso si tiene un token válido en auth.token.
  - El frontend debe adaptarse para enviar ?token= en la conexión Socket.IO
    (socket = io(url, { auth: { token }, query: { token } })).

Para Orders: el servicio ya valida el token en modo auth.token (handshake.auth.token),
por lo que si el gateway rechaza, Orders no lo va a ver; requiere adaptar el cliente.
Para Notifications: la mejora de seguridad (forzar userId verificado) requiere el cambio
de cliente mencionado arriba.
```

---

## 7. Caso 404 / primer login (sync-profile)

Cuando un usuario valida su token Firebase por primera vez pero aún no ejecutó
`POST /identity/auth/sync-profile`, el endpoint de enriquecimiento devuelve 404.

**Comportamiento del gateway:**

| Ruta solicitada | Comportamiento |
|---|---|
| `POST /identity/auth/sync-profile` | Ruta semi-pública: se valida el token Firebase pero NO se llama al enriquecimiento. Se reenvía `Authorization: Bearer` a Identity que lo gestiona. Funciona aunque no haya perfil local. |
| Cualquier otra ruta protegida | El enriquecimiento devuelve 404 → gateway responde `403 { code: "PROFILE_NOT_FOUND", message: "Ejecuta POST /identity/auth/sync-profile primero" }` |

El frontend debe detectar este 403 con `code: PROFILE_NOT_FOUND` y redirigir al flujo de
onboarding antes de intentar cualquier otra operación.

---

## 8. Usuarios no-ACTIVE

Tras el enriquecimiento, si `identity.status !== 'ACTIVE'`:

```json
HTTP 403
{
  "code": "USER_INACTIVE",
  "status": "SUSPENDED",
  "message": "Tu cuenta está SUSPENDED. Contacta al administrador."
}
```

El gateway rechaza inmediatamente, sin reenviar al servicio downstream. El caché de
enriquecimiento también guarda el status, por lo que si un admin desactiva un usuario,
el rechazo comenzará a aplicarse en ≤ `ENRICHMENT_CACHE_TTL_SECONDS` segundos (default 60).

---

## 9. Webhook Wompi

- **Ruta pública:** `POST /financial/webhooks/wompi`
- **Por qué pública:** Wompi llama desde servidores propios sin token de Firebase. Se autentica
  por firma SHA256 del body, no por JWT.
- **Importante:** el gateway NO reescribe ni transforma el body del webhook. Usa `rawBody: true`
  en `NestFactory.create` y el `proxyReq` handler de http-proxy re-envía el buffer crudo
  (`req.rawBody`) sin modificarlo. Si se normalizara el body, la verificación de firma en Financial
  fallaría.
- **Rewrite de path:** `/financial/webhooks/wompi` → `/webhooks/wompi` en Financial (Financial no
  tiene global prefix, la ruta interna es `/webhooks/wompi`).

> ⚠️ **Al desplegar:** actualizar la URL del webhook en el panel de Wompi
> (Settings → Webhooks) con la URL pública del gateway:
> `https://<gateway-domain>/financial/webhooks/wompi`
> Hoy la URL apunta a Render; debe cambiarse al desplegar en Container Apps.

---

## 10. Rutas bloqueadas

Las siguientes rutas devuelven `404 NOT_FOUND` y nunca llegan a los servicios:

| Ruta | Motivo |
|---|---|
| `/identity/internal/*` | Endpoints service-to-service (`@Public()` solo para tráfico interno). Expuestos desde internet cualquiera podría consultar `/internal/users/:id/validate` sin token. |
| `/notifications/send` | Solo para uso interno entre microservicios. El código de Notifications advierte explícitamente que no debe exponerse al público. |
| `/notifications/wakeup` | TODO: cron de keep-alive sin auth definida. No exponer hasta decidir mecanismo de autenticación (secreto propio o solo red interna). |
| `/<servicio>/api` | Swagger de los servicios. No exponer en producción. |

**Ver:** RUTAS_GATEWAY.md Observación 4 y Observación 8 (aislamiento de red como complemento).

---

## 11. Variables de entorno requeridas

Ver `.env.example` para la lista completa con comentarios. Las mínimas para arrancar:

```
FIREBASE_SERVICE_ACCOUNT_JSON  o  GOOGLE_APPLICATION_CREDENTIALS
IDENTITY_SERVICE_URL
PRODUCTS_SERVICE_URL
ORDERS_SERVICE_URL
FINANCIAL_SERVICE_URL
FULFILLMENT_SERVICE_URL
NOTIFICATIONS_SERVICE_URL
REPORTING_SERVICE_URL
```

Redis (`REDIS_URL`) es opcional — el gateway degrada a memoria si no está configurado.
