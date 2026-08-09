import { MemoryStorage } from '../memoryStorage.js';
import { mongoDb } from './mongoDb.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

/**
 * MongoDB-only wrapper.
 * NEVER uses memory fallback when MONGODB_URI is set (that was wiping levels on restart).
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
      const allowMem = process.env.ALLOW_MEMORY_DB === '1';
      if (!allowMem) {
        throw new Error(
          'MONGODB_URI is missing. Refusing memory DB (would reset levels on restart).',
        );
      }
      logger.error('MONGODB_URI missing — memory DB (ALLOW_MEMORY_DB=1)');
      this.db = new MemoryStorage();
      this.useFallback = true;
      this.connectionType = 'memory';
      this.degradedReason = 'NO_MONGODB_URI';
      this.initialized = true;
      return;
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.info(`Connecting to MongoDB Atlas (attempt ${attempt}/3)...`);
        const ok = await mongoDb.connect();
        if (ok) {
          this.db = mongoDb;
          this.connectionType = 'mongodb';
          this.useFallback = false;
          this.degradedReason = null;
          this.initialized = true;
          logger.info('✅ MongoDB Atlas initialized (levels persist here)');
          return;
        }
        lastErr = new Error('mongoDb.connect returned false');
      } catch (error) {
        lastErr = error;
        logger.warn(`Mongo attempt ${attempt} failed:`, error.message);
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }

    // Do NOT fall back to memory — that resets levels every restart
    throw new Error(
      `MongoDB unavailable after 3 attempts: ${lastErr?.message || lastErr}. Levels not loaded.`,
    );
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
    return value !== null && value !== undefined;
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
    throw error; // surface to app start — better crash than silent memory wipe
  }
}

export async function getFromDb(key, defaultValue = null) {
  try {
    const value = await db.get(key);
    return value === null || value === undefined ? defaultValue : value;
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
