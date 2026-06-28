export interface GatewayEnv {
  PORT: number;
  CORS_ORIGINS: string;
  FIREBASE_SERVICE_ACCOUNT_JSON: string | undefined;
  IDENTITY_SERVICE_URL: string;
  PRODUCTS_SERVICE_URL: string;
  ORDERS_SERVICE_URL: string;
  FINANCIAL_SERVICE_URL: string;
  FULFILLMENT_SERVICE_URL: string;
  NOTIFICATIONS_SERVICE_URL: string;
  REPORTING_SERVICE_URL: string;
  REDIS_URL: string | undefined;
  ENRICHMENT_CACHE_TTL_SECONDS: number;
  THROTTLE_LIMIT: number;
  THROTTLE_TTL_MS: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optionalEnv(key: string): string | undefined {
  return process.env[key] || undefined;
}

function intEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Environment variable ${key} must be a number, got: ${raw}`);
  return parsed;
}

export function loadEnv(): GatewayEnv {
  return {
    PORT: intEnv('PORT', 3000),
    CORS_ORIGINS: process.env['CORS_ORIGINS'] ?? '*',
    FIREBASE_SERVICE_ACCOUNT_JSON: optionalEnv('FIREBASE_SERVICE_ACCOUNT_JSON'),
    IDENTITY_SERVICE_URL: requireEnv('IDENTITY_SERVICE_URL'),
    PRODUCTS_SERVICE_URL: requireEnv('PRODUCTS_SERVICE_URL'),
    ORDERS_SERVICE_URL: requireEnv('ORDERS_SERVICE_URL'),
    FINANCIAL_SERVICE_URL: requireEnv('FINANCIAL_SERVICE_URL'),
    FULFILLMENT_SERVICE_URL: requireEnv('FULFILLMENT_SERVICE_URL'),
    NOTIFICATIONS_SERVICE_URL: requireEnv('NOTIFICATIONS_SERVICE_URL'),
    REPORTING_SERVICE_URL: requireEnv('REPORTING_SERVICE_URL'),
    REDIS_URL: optionalEnv('REDIS_URL'),
    ENRICHMENT_CACHE_TTL_SECONDS: intEnv('ENRICHMENT_CACHE_TTL_SECONDS', 60),
    THROTTLE_LIMIT: intEnv('THROTTLE_LIMIT', 60),
    THROTTLE_TTL_MS: intEnv('THROTTLE_TTL_MS', 60000),
  };
}

export const ENV_CONFIG = Symbol('ENV_CONFIG');
