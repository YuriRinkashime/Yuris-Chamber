import admin from 'firebase-admin';
import { logger } from '../logger.js';

let initialized = false;

function ensureInit() {
  if (initialized) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing');
  }

  let cred;
  try {
    cred = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(cred),
    });
  }

  initialized = true;
  logger.info('Firebase Admin initialized');
}

function kv() {
  ensureInit();
  return admin.firestore().collection('kv');
}

/** Firestore doc ids cannot contain /. Encode keys. */
function toDocId(key) {
  return encodeURIComponent(String(key));
}

function fromDocId(id) {
  return decodeURIComponent(String(id));
}

class FirebaseKvStore {
  async connect() {
    try {
      ensureInit();
      // lightweight check
      await kv().limit(1).get();
      return true;
    } catch (error) {
      logger.error('Firebase connect failed:', error.message);
      return false;
    }
  }

  async get(key, defaultValue = null) {
    try {
      const snap = await kv().doc(toDocId(key)).get();
      if (!snap.exists) return defaultValue;
      const data = snap.data();
      return data?.value !== undefined ? data.value : defaultValue;
    } catch (error) {
      logger.error(`Firebase get(${key}):`, error.message);
      return defaultValue;
    }
  }

  async set(key, value, _ttl = null) {
    await kv().doc(toDocId(key)).set({
      value,
      updatedAt: Date.now(),
    });
    return true;
  }

  async delete(key) {
    await kv().doc(toDocId(key)).delete();
    return true;
  }

  async list(prefix = '') {
    const snap = await kv().get();
    const keys = [];
    const p = String(prefix || '');
    snap.forEach((doc) => {
      const key = fromDocId(doc.id);
      if (!p || key.startsWith(p)) keys.push(key);
    });
    return keys;
  }

  async exists(key) {
    const snap = await kv().doc(toDocId(key)).get();
    return snap.exists;
  }

  async increment(key, amount = 1) {
    const current = Number(await this.get(key, 0)) || 0;
    const next = current + amount;
    await this.set(key, next);
    return next;
  }

  async decrement(key, amount = 1) {
    return this.increment(key, -amount);
  }
}

export const firebaseDb = new FirebaseKvStore();
export default firebaseDb;
