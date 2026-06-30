import { LoggerService, LogLevel } from '@nestjs/common';
import { Contracts } from 'applicationinsights';
import { loggingStorage } from './logging.context';
import { getTelemetryClient } from '../telemetry/app-insights';
import { SERVICE_NAME } from '../telemetry/service-name';

/**
 * Reemplaza el logger por defecto de NestJS.
 *
 * Emite JSON estructurado a stdout/stderr (visible en `az containerapp logs`) y,
 * si Application Insights está configurado, envía cada entrada como trackTrace
 * con las propiedades serviceName y userId, de modo que en AI se pueda:
 *   - filtrar por microservicio:  customDimensions.serviceName == 'financial-service'
 *   - trazar a un usuario:        customDimensions.userId == '<uuid>'
 *
 * El userId se toma del contexto HTTP (AsyncLocalStorage, lo rellena
 * LoggingMiddleware a partir del header x-user-id).
 */
const SEVERITY: Record<string, Contracts.SeverityLevel> = {
  verbose: Contracts.SeverityLevel.Verbose,
  debug: Contracts.SeverityLevel.Verbose,
  info: Contracts.SeverityLevel.Information,
  warn: Contracts.SeverityLevel.Warning,
  error: Contracts.SeverityLevel.Error,
  fatal: Contracts.SeverityLevel.Critical,
};

export class StructuredLogger implements LoggerService {
  private write(
    level: string,
    message: unknown,
    context?: string,
    trace?: string,
  ): void {
    const userId = loggingStorage.getStore()?.userId;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      service: SERVICE_NAME,
      ...(context && { context }),
      ...(userId && { userId }),
      message: typeof message === 'object' ? message : String(message),
      ...(trace && { trace }),
    };
    const out = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    out.write(JSON.stringify(entry) + '\n');

    this.toAppInsights(level, message, context, userId, trace);
  }

  private toAppInsights(
    level: string,
    message: unknown,
    context: string | undefined,
    userId: string | undefined,
    trace: string | undefined,
  ): void {
    const client = getTelemetryClient();
    if (!client) return;

    const properties: Record<string, string> = { serviceName: SERVICE_NAME };
    if (context) properties.context = context;
    if (userId) properties.userId = userId;
    if (trace) properties.trace = trace;

    client.trackTrace({
      message: typeof message === 'object' ? JSON.stringify(message) : String(message),
      severity: SEVERITY[level] ?? Contracts.SeverityLevel.Information,
      properties,
    });
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    const context = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    this.write('info', message, context);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    // NestJS llama error(message, stack?, context?)
    const trace = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    const context = typeof optionalParams[1] === 'string' ? optionalParams[1] : undefined;
    this.write('error', message, context, trace);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const context = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    this.write('warn', message, context);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    const context = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    this.write('debug', message, context);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const context = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    this.write('verbose', message, context);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    const context = typeof optionalParams[0] === 'string' ? optionalParams[0] : undefined;
    this.write('fatal', message, context);
  }

  setLogLevels(_levels: LogLevel[]): void {}
}
