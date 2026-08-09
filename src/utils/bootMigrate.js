/**
 * Optional one-shot Firebase → Mongo migration when env MIGRATE_ON_BOOT=1
 * Logs to console so Bot-Hosting startup log shows progress.
 */
import admin from 'firebase-admin';
import { MongoClient } from 'mongodb';
import { logger } from './logger.js';

function fromDocId(id) {
  try {
    return decodeURIComponent(String(id));
  } catch {
    return String(id);
  }
}

export async function runFirebaseToMongoMigrationIfRequested() {
  if (String(process.env.MIGRATE_ON_BOOT || '') !== '1') {
    return { skipped: true };
  }

  logger.info('[migrate] MIGRATE_ON_BOOT=1 — starting Firebase → Mongo transfer');

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const firebaseRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!uri) {
    logger.error('[migrate] Missing MONGODB_URI — abort');
    return { ok: false, error: 'no mongo uri' };
  }
  if (!firebaseRaw) {
    logger.error('[migrate] Missing FIREBASE_SERVICE_ACCOUNT — abort');
    return { ok: false, error: 'no firebase' };
  }

  let cred;
  try {
    cred = typeof firebaseRaw === 'string' ? JSON.parse(firebaseRaw) : firebaseRaw;
  } catch (e) {
    logger.error('[migrate] Bad FIREBASE_SERVICE_ACCOUNT JSON');
    return { ok: false, error: 'bad json' };
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    }
    const firestore = admin.firestore();

    logger.info('[migrate] Connecting Mongo...');
    const client = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 20_000,
    });
    await client.connect();
    await client.db().command({ ping: 1 });

    let dbName = process.env.MONGODB_DB || 'yuris_chamber';
    try {
      const path = new URL(uri).pathname.replace(/^\//, '').split('?')[0];
      if (path) dbName = path;
    } catch (_) {}

    const mongoCol = client.db(dbName).collection('kv');
    logger.info(`[migrate] Reading Firebase kv (may fail if quota empty)...`);

    const snap = await firestore.collection('kv').get();
    logger.info(`[migrate] Found ${snap.size} Firebase documents`);

    let ok = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await mongoCol.bulkWrite(batch, { ordered: false });
      ok += batch.length;
      logger.info(`[migrate] written ${ok}/${snap.size}`);
      batch = [];
    };

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (!('value' in data)) continue;
      batch.push({
        updateOne: {
          filter: { _id: fromDocId(doc.id) },
          update: {
            $set: {
              value: data.value,
              updatedAt: data.updatedAt || Date.now(),
              migratedFrom: 'firebase',
              migratedAt: Date.now(),
            },
          },
          upsert: true,
        },
      });
      if (batch.length >= 50) await flush();
    }
    await flush();

    const count = await mongoCol.countDocuments();
    logger.info(`[migrate] DONE. Mongo kv count=${count}`);
    await client.close();

    logger.info(
      '[migrate] Set MIGRATE_ON_BOOT=0 (or remove it), keep DB_DRIVER=mongodb, restart again.',
    );
    return { ok: true, count };
  } catch (e) {
    logger.error('[migrate] FAILED:', e.message || e);
    if (String(e.message || e).includes('RESOURCE_EXHAUSTED')) {
      logger.error(
        '[migrate] Firebase quota empty — wait for daily reset, then Start again with MIGRATE_ON_BOOT=1',
      );
    }
    return { ok: false, error: e.message };
  }
}
