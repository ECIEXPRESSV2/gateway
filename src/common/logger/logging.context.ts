import { AsyncLocalStorage } from 'async_hooks';

export interface LoggingStore {
  userId?: string;
}

export const loggingStorage = new AsyncLocalStorage<LoggingStore>();
