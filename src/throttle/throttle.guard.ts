import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

// Extract the Firebase UID from a JWT without verifying the signature.
// Used ONLY for rate-limiting key derivation — the actual verification happens
// in the proxy handler. This avoids a round-trip to Firebase just for the key.
function extractUidUnsafe(token: string): string | null {
  try {
    const [, payloadB64] = token.split('.');
    if (!payloadB64) return null;
    const padding = (4 - (payloadB64.length % 4)) % 4;
    const padded = payloadB64 + '='.repeat(padding);
    const json = Buffer.from(padded, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { user_id?: string; uid?: string; sub?: string };
    return payload.user_id ?? payload.uid ?? payload.sub ?? null;
  } catch {
    return null;
  }
}

@Injectable()
export class GatewayThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader?.startsWith('Bearer ')) {
      const uid = extractUidUnsafe(authHeader.slice(7));
      if (uid) return `uid:${uid}`;
    }
    // Fall back to IP for unauthenticated / public requests
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.ip ??
      req.socket.remoteAddress ??
      'unknown';
    return `ip:${ip}`;
  }

  protected async shouldSkip(_context: ExecutionContext): Promise<boolean> {
    return false;
  }
}
