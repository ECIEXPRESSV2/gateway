import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { loggingStorage } from './logging.context';

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const userId = req.headers['x-user-id'] as string | undefined;
    loggingStorage.run({ userId }, next);
  }
}
