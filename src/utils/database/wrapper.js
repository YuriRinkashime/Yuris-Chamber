import { MemoryStorage } from '../memoryStorage.js';
import { firebaseDb } from './firebaseDb.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

class DatabaseWrapper {
  constructor() {
    this.initialized = false;
    this.db = null;
    this.useFallback = false;
    this.connectionType = 'none';
    this.degradedModeWarningShown = false;
    this.degradedReason = null;
  }

  async initialize() {
    if (this.initialized) return;

    // Firebase only
    try {
      logger.info('Attempting to connect to Firebase Firestore...');
      const ok = await firebaseDb.connect();
      if (ok) {
        this.db = firebaseDb;
        this.connectionType = 'firebase';
        this.useFallback = false;
        this.degradedReason = null;
        this.initialized = true;
        logger.info('✅ Firebase Firestore initialized');
        return;
      }
    } catch (error) {
      logger.warn('Firebase connection failed:', error.message);
    }

    // Memory fallback only if Firebase fails
    this.db = new MemoryStorage();
    this.useFallback = true;
    this.connectionType = 'memory';
    this.degradedReason = 'FIREBASE_UNAVAILABLE';
    logger.warn('⚠️ DATABASE DEGRADED - in-memory only (data lost on restart)');
    this.initialized = true;
    this.degradedModeWarningShown = true;
  }

  async set(key, value, ttl = null) {
    if (typeof key === 'string' && /^guild:[^:]+:config$/.test(key)) {
      const guildId = key.split(':')[1];
      validateGuildConfigOrThrow(value, {
        guildId,
        errorCode: 'VALIDATION_FAILED',
      });
    }
    return this.db.set(key, value, ttl);
  }

  async get(key, defaultValue = null) {
    return this.db.get(key, defaultValue);
  }

  async delete(key) {
    return this.db.delete(key);
  }

  async list(prefix) {
    return this.db.list(prefix);
  }

  async exists(key) {
    if (this.db.exists) return this.db.exists(key);
    const value = await this.db.get(key);
    return value !== null;
  }

  async increment(key, amount = 1) {
    if (this.db.increment) return this.db.increment(key, amount);
    const current = await this.db.get(key, 0);
    const newValue = current + amount;
    await this.db.set(key, newValue);
    return newValue;
  }

  async decrement(key, amount = 1) {
    if (this.db.decrement) return this.db.decrement(key, amount);
    const current = await this.db.get(key, 0);
    const newValue = current - amount;
    await this.db.set(key, newValue);
    return newValue;
  }

  isDegraded() {
    return this.useFallback;
  }

  isAvailable() {
    return this.db && !this.useFallback;
  }

  getStatus() {
    return {
      initialized: this.initialized,
      connectionType: this.connectionType,
      isDegraded: this.useFallback,
      isAvailable: this.isAvailable(),
      degradedReason: this.degradedReason,
    };
  }

  getConnectionType() {
    return this.connectionType;
  }
}

export const db = new DatabaseWrapper();

export async function initializeDatabase() {
  try {
    logger.info('Initializing Database (Firebase)...');
    await db.initialize();
    logger.info('✅ Database initialized');
    return { db };
  } catch (error) {
    logger.error('❌ Database Initialization Error:', error);
    return { db };
  }
}

export async function getFromDb(key, defaultValue = null) {
  try {
    const value = await db.get(key);
    return value === null ? defaultValue : value;
  } catch (error) {
    logger.error(`Error getting value for key ${key}:`, error);
    return defaultValue;
  }
}

export async function setInDb(key, value, ttl = null) {
  try {
    await db.set(key, value, ttl);
    return true;
  } catch (error) {
    logger.error(`Error setting value for key ${key}:`, error);
    return false;
  }
}

export async function deleteFromDb(key) {
  try {
    await db.delete(key);
    return true;
  } catch (error) {
    logger.error(`Error deleting key ${key}:`, error);
    return false;
  }
}
