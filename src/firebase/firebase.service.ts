import { Injectable, OnModuleInit, Logger, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: admin.app.App;

  onModuleInit() {
    if (admin.apps.length > 0) {
      this.app = admin.apps[0]!;
      return;
    }

    const jsonStr = process.env['FIREBASE_SERVICE_ACCOUNT_JSON'];
    if (jsonStr) {
      const serviceAccount = JSON.parse(jsonStr) as admin.ServiceAccount;
      this.app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      this.logger.log('Firebase initialized from FIREBASE_SERVICE_ACCOUNT_JSON');
    } else if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
      // firebase-admin picks up GOOGLE_APPLICATION_CREDENTIALS automatically
      this.app = admin.initializeApp({ credential: admin.credential.applicationDefault() });
      this.logger.log('Firebase initialized from GOOGLE_APPLICATION_CREDENTIALS');
    } else {
      throw new Error(
        'Firebase credentials not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
      );
    }
  }

  async verifyIdToken(token: string): Promise<admin.auth.DecodedIdToken> {
    try {
      return await this.app.auth().verifyIdToken(token, true);
    } catch (err: any) {
      throw new UnauthorizedException(`Invalid Firebase token: ${err?.message ?? 'unknown'}`);
    }
  }
}
