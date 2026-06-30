import * as appInsights from 'applicationinsights';
import { SERVICE_NAME } from './service-name';

let client: appInsights.TelemetryClient | undefined;

/**
 * Inicializa Application Insights usando APPLICATIONINSIGHTS_CONNECTION_STRING,
 * que la infra (Terraform) inyecta como variable de entorno en cada Container App.
 *
 * Es idempotente y un no-op si la variable no está presente (p. ej. en local o en
 * tests), de modo que el arranque nunca falla por falta de telemetría: los logs
 * siguen saliendo por stdout vía StructuredLogger.
 *
 * Marca cloud_RoleName = SERVICE_NAME para identificar el microservicio en el
 * Application Map y permitir filtrar por servicio en KQL.
 */
export function setupAppInsights(): void {
  if (client) return;

  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) return;

  appInsights
    .setup(connectionString)
    // La consola la emite StructuredLogger explícitamente vía trackTrace; evitamos
    // duplicar cada línea de stdout como traza adicional.
    .setAutoCollectConsole(false)
    .setAutoCollectRequests(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectPerformance(true, true)
    .setSendLiveMetrics(true)
    .setUseDiskRetryCaching(true)
    .start();

  const c = appInsights.defaultClient;
  c.context.tags[c.context.keys.cloudRole] = SERVICE_NAME;
  client = c;
}

/**
 * Devuelve el cliente de telemetría ya inicializado, o undefined si Application
 * Insights no está configurado (local/tests). Los emisores de logs deben tratar
 * undefined como "no enviar a AI".
 */
export function getTelemetryClient(): appInsights.TelemetryClient | undefined {
  return client;
}
