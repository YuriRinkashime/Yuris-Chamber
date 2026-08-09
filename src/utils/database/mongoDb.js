import { MongoClient } from 'mongodb';
import { logger } from '../logger.js';

/**
 * MongoDB Atlas KV store — same interface as firebaseDb
 * Collection: kv  |  documents: { _id: key, value, updatedAt }
 */

let client = null;
let collection = null;
let connected = false;

const cache = new Map();
const DEFAULT_TTL_MS = 30_000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) return { value: hit.value, stale: true };
  return { value: hit.value, stale: false };
}

function cacheSet(key, value, ttl = DEFAULT_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  if (cache.size > 3000) {
    const k = cache.keys().next().value;
    cache.delete(k);
  }
}

function cacheDel(key) {
  cache.delete(key);
}

class MongoKvStore {
  async connect() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
      throw new Error('MONGODB_URI env var is missing');
    }

    try {
      client = new MongoClient(uri, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 15_000,
      });
      await client.connect();
      // ping
      await client.db().command({ ping: 1 });
      const dbName =
        process.env.MONGODB_DB ||
        (() => {
          try {
            const path = new URL(uri).pathname.replace(/^\//, '');
            return path.split('?')[0] || 'yuris_chamber';
          } catch {
            return 'yuris_chamber';
          }
        })();
      const db = client.db(dbName || 'yuris_chamber');
      collection = db.collection('kv');
      await collection.createIndex({ _id: 1 }).catch(() => {});
      connected = true;
      logger.info(`✅ MongoDB connected (db=${dbName}, collection=kv)`);
      return true;
    } catch (error) {
      logger.error('MongoDB connect failed:', error.message);
      connected = false;
      return false;
    }
  }

  async get(key, defaultValue = null) {
    const k = String(key);
    const cached = cacheGet(k);
    if (cached && !cached.stale) {
      return cached.value !== undefined ? cached.value : defaultValue;
    }

    if (!collection) return defaultValue;

    try {
      const doc = await collection.findOne({ _id: k });
      if (!doc || !('value' in doc)) {
        cacheSet(k, defaultValue);
        return defaultValue;
      }
      cacheSet(k, doc.value);
      return doc.value;
    } catch (error) {
      logger.error(`Mongo get(${k}):`, error.message);
      if (cached) return cached.value !== undefined ? cached.value : defaultValue;
      return defaultValue;
    }
  }

  async set(key, value, _ttl = null) {
    const k = String(key);
    cacheSet(k, value);
    if (!collection) return true;
    await collection.updateOne(
      { _id: k },
      { $set: { value, updatedAt: Date.now() } },
      { upsert: true },
    );
    return true;
  }

  async delete(key) {
    const k = String(key);
    cacheDel(k);
    if (!collection) return true;
    await collection.deleteOne({ _id: k });
    return true;
  }

  async list(prefix = '') {
    if (!collection) return [];
    const p = String(prefix || '');
    const filter = p ? { _id: { $regex: `^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } } : {};
    const docs = await collection.find(filter).project({ _id: 1 }).toArray();
    return docs.map((d) => d._id);
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

export const mongoDb = new MongoKvStore();
export default mongoDb;
