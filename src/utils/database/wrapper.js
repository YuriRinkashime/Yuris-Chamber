import { MemoryStorage } from '../memoryStorage.js';
import { mongoDb } from './mongoDb.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

/**
 * MongoDB-only database wrapper (Firebase removed)
 */
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

    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
      logger.error('MONGODB_URI is missing — falling back to memory');
      this.db = new MemoryStorage();
      this.useFallback = true;
      this.connectionType = 'memory';
      this.degradedReason = 'NO_MONGODB_URI';
      this.initialized = true;
      return;
    }

    try {
      logger.info('Connecting to MongoDB Atlas...');
      const ok = await mongoDb.connect();
      if (ok) {
        this.db = mongoDb;
        this.connectionType = 'mongodb';
        this.useFallback = false;
        this.degradedReason = null;
        this.initialized = true;
        logger.info('✅ MongoDB Atlas initialized');
        return;
      }
    } catch (error) {
      logger.warn('MongoDB connection failed:', error.message);
    }

    this.db = new MemoryStorage();
    this.useFallback = true;
    this.connectionType = 'memory';
    this.degradedReason = 'MONGODB_UNAVAILABLE';
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
    const newValue = (Number(current) || 0) + amount;
    await this.db.set(key, newValue);
    return newValue;
  }

  async decrement(key, amount = 1) {
    return this.increment(key, -amount);
  }

  isAvailable() {
    return this.initialized && !this.useFallback;
  }

  isDegraded() {
    return this.useFallback;
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
    logger.info('Initializing Database (MongoDB)...');
    await db.initialize();
    logger.info(`✅ Database initialized (${db.getConnectionType()})`);
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
