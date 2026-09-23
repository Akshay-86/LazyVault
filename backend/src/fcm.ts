import admin from 'firebase-admin';
import { EventEmitter } from 'events';
import { FileRequest } from './types.js';

export class FcmService {
  private isFirebaseInitialized = false;
  public devEvents = new EventEmitter();

  constructor() {
    this.initFirebase();
  }

  private initFirebase() {
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (serviceAccountJson) {
      try {
        const creds = JSON.parse(serviceAccountJson);
        admin.initializeApp({
          credential: admin.credential.cert(creds),
        });
        this.isFirebaseInitialized = true;
        console.log('[FCM] Initialized with inline service account credentials.');
      } catch (err) {
        console.warn('[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err);
      }
    } else if (credPath) {
      try {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
        this.isFirebaseInitialized = true;
        console.log('[FCM] Initialized with application default credentials.');
      } catch (err) {
        console.warn('[FCM] Failed to initialize Firebase from GOOGLE_APPLICATION_CREDENTIALS:', err);
      }
    } else {
      console.log('[FCM] No Firebase credentials provided. Running in Hybrid/Dev mode (SSE push trigger enabled).');
    }
  }

  public async dispatchApprovalRequest(
    fcmToken: string | undefined,
    request: FileRequest
  ): Promise<{ sentViaFcm: boolean; sentViaDevBridge: boolean }> {
    const payloadData = {
      action: 'REQUEST_APPROVAL',
      request_id: request.id,
      nonce: request.nonce,
      path: request.path,
      sha256: request.targetSha256,
      requester_context: request.requesterContext,
      requester_ip: request.requesterIp,
      supported_transports: JSON.stringify(request.supportedTransports),
      expires_at: request.expiresAt.toString(),
    };

    let sentViaFcm = false;

    if (this.isFirebaseInitialized && fcmToken) {
      try {
        const message: admin.messaging.Message = {
          token: fcmToken,
          data: payloadData,
          android: {
            priority: 'high',
            ttl: 60 * 1000, // 60 seconds
          },
        };
        const messageId = await admin.messaging().send(message);
        console.log(`[FCM] High-priority data message sent successfully: ${messageId}`);
        sentViaFcm = true;
      } catch (error) {
        console.error('[FCM] Error dispatching push notification:', error);
      }
    }

    // Always emit on the dev bridge so testing and local development work without Google Play Services
    this.devEvents.emit('request_trigger', {
      ...payloadData,
      supported_transports: request.supportedTransports,
      timestamp: Date.now(),
    });

    return { sentViaFcm, sentViaDevBridge: true };
  }
}

export const fcmService = new FcmService();
