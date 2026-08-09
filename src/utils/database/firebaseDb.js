import admin from 'firebase-admin';
import { logger } from '../logger.js';

let initialized = false;

/** In-memory cache to stay under Firebase free-tier read quota */
const cache = new Map(); // key -> { value, expiresAt }
const DEFAULT_TTL_MS = 60_000; // 60s
const HOT_TTL_MS = 30_000; // hot keys
const HOT_KEYS = new Set([
  'bot:presence',
  'polls:active',
  'polls:ended',
  'dm:inbox',
]);

let quotaBlockedUntil = 0;

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
  logger.info('Firebase Admin initialized (with memory cache)');
}

function kv() {
  ensureInit();
  return admin.firestore().collection('kv');
}

function toDocId(key) {
  return encodeURIComponent(String(key));
}

function fromDocId(id) {
  return decodeURIComponent(String(id));
}

function isQuotaError(error) {
  const msg = String(error?.message || error || '');
  const code = error?.code;
  return (
    code === 8 ||
    code === 'resource-exhausted' ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('Quota exceeded')
  );
}

function ttlFor(key) {
  if (HOT_KEYS.has(key)) return HOT_TTL_MS;
  if (key.startsWith('guild:') && key.endsWith(':config')) return 120_000;
  if (key.startsWith('poll:')) return 45_000;
  if (key.startsWith('dm:')) return 30_000;
  return DEFAULT_TTL_MS;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    // keep stale value for quota fallback
    return { value: hit.value, stale: true };
  }
  return { value: hit.value, stale: false };
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + (ttlMs ?? ttlFor(key)),
  });
  // bound memory
  if (cache.size > 2000) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

class FirebaseKvStore {
  async connect() {
    try {
      ensureInit();
      // Avoid extra read if possible — just init
      return true;
    } catch (error) {
      logger.error('Firebase connect failed:', error.message);
      return false;
    }
  }

  isQuotaBlocked() {
    return Date.now() < quotaBlockedUntil;
  }

  async get(key, defaultValue = null) {
    const k = String(key);

    // Serve cache while quota is blocked
    if (this.isQuotaBlocked()) {
      const hit = cacheGet(k);
      if (hit) return hit.value !== undefined ? hit.value : defaultValue;
      return defaultValue;
    }

    const cached = cacheGet(k);
    if (cached && !cached.stale) {
      return cached.value !== undefined ? cached.value : defaultValue;
    }

    try {
      const snap = await kv().doc(toDocId(k)).get();
      if (!snap.exists) {
        cacheSet(k, defaultValue);
        return defaultValue;
      }
      const data = snap.data();
      const value = data?.value !== undefined ? data.value : defaultValue;
      cacheSet(k, value);
      return value;
    } catch (error) {
      if (isQuotaError(error)) {
        quotaBlockedUntil = Date.now() + 5 * 60_000; // back off 5 minutes
        logger.error(
          `Firebase QUOTA exceeded — using cache for 5 min (get ${k})`,
        );
        const hit = cacheGet(k);
        if (hit) return hit.value !== undefined ? hit.value : defaultValue;
        return defaultValue;
      }
      logger.error(`Firebase get(${k}):`, error.message);
      const hit = cacheGet(k);
      if (hit) return hit.value !== undefined ? hit.value : defaultValue;
      return defaultValue;
    }
  }

  async set(key, value, _ttl = null) {
    const k = String(key);
    cacheSet(k, value); // optimistic local update
    if (this.isQuotaBlocked()) {
      logger.warn(`Firebase set(${k}) deferred in memory — quota blocked`);
      return true;
    }
    try {
      await kv().doc(toDocId(k)).set({
        value,
        updatedAt: Date.now(),
      });
      return true;
    } catch (error) {
      if (isQuotaError(error)) {
        quotaBlockedUntil = Date.now() + 5 * 60_000;
        logger.error(`Firebase QUOTA on set(${k}) — value kept in memory only`);
        return true;
      }
      logger.error(`Firebase set(${k}):`, error.message);
      throw error;
    }
  }

  async delete(key) {
    const k = String(key);
    cache.delete(k);
    if (this.isQuotaBlocked()) return true;
    try {
      await kv().doc(toDocId(k)).delete();
      return true;
    } catch (error) {
      if (isQuotaError(error)) {
        quotaBlockedUntil = Date.now() + 5 * 60_000;
        return true;
      }
      throw error;
    }
  }

  async list(prefix = '') {
    // Expensive — avoid on free tier; prefer not calling this
    if (this.isQuotaBlocked()) return [];
    try {
      const snap = await kv().get();
      const keys = [];
      const p = String(prefix || '');
      snap.forEach((doc) => {
        const key = fromDocId(doc.id);
        if (!p || key.startsWith(p)) keys.push(key);
      });
      return keys;
    } catch (error) {
      if (isQuotaError(error)) {
        quotaBlockedUntil = Date.now() + 5 * 60_000;
      }
      logger.error('Firebase list:', error.message);
      return [];
    }
  }

  async exists(key) {
    const v = await this.get(key, undefined);
    return v !== undefined && v !== null;
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
