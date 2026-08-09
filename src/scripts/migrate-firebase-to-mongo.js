/**
 * One-time: Firebase kv → MongoDB kv
 * node src/scripts/migrate-firebase-to-mongo.js
 */
import 'dotenv/config';
import admin from 'firebase-admin';
import { MongoClient } from 'mongodb';

console.log('[1] Script started');
console.log('[1] Node', process.version);
console.log('[1] CWD', process.cwd());

const uri = process.env.MONGODB_URI || process.env.MONGO_URI || '';
const firebaseRaw = process.env.FIREBASE_SERVICE_ACCOUNT || '';

console.log('[2] MONGODB_URI set?', !!uri, uri ? `(len=${uri.length})` : '');
console.log('[2] FIREBASE_SERVICE_ACCOUNT set?', !!firebaseRaw, firebaseRaw ? `(len=${firebaseRaw.length})` : '');

if (!uri) {
  console.error('FAIL: Missing MONGODB_URI in env');
  process.exit(1);
}
if (!firebaseRaw) {
  console.error('FAIL: Missing FIREBASE_SERVICE_ACCOUNT in env (needed for export)');
  process.exit(1);
}

let cred;
try {
  cred = typeof firebaseRaw === 'string' ? JSON.parse(firebaseRaw) : firebaseRaw;
  console.log('[3] Firebase JSON parsed OK, project_id=', cred.project_id || cred.projectId || '?');
} catch (e) {
  console.error('FAIL: FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message);
  process.exit(1);
}

function fromDocId(id) {
  try {
    return decodeURIComponent(String(id));
  } catch {
    return String(id);
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

async function main() {
  console.log('[4] Init Firebase Admin...');
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    }
    console.log('[4] Firebase Admin OK');
  } catch (e) {
    console.error('FAIL Firebase init:', e.message);
    process.exit(1);
  }

  const firestore = admin.firestore();
  // Avoid long hangs
  try {
    firestore.settings({ ignoreUndefinedProperties: true });
  } catch (_) {}

  console.log('[5] Connect MongoDB (15s timeout)...');
  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });
  try {
    await withTimeout(client.connect(), 20_000, 'mongo connect');
    await withTimeout(client.db().command({ ping: 1 }), 10_000, 'mongo ping');
    console.log('[5] MongoDB connected');
  } catch (e) {
    console.error('FAIL MongoDB:', e.message);
    console.error('Check: Network Access 0.0.0.0/0 Active, password URL-encoded, URI correct');
    process.exit(1);
  }

  let dbName = process.env.MONGODB_DB || 'yuris_chamber';
  try {
    const path = new URL(uri).pathname.replace(/^\//, '').split('?')[0];
    if (path) dbName = path;
  } catch (_) {}
  const mongoCol = client.db(dbName).collection('kv');
  console.log('[5] Mongo db=', dbName, 'collection=kv');

  console.log('[6] Reading Firebase collection kv (60s timeout)...');
  console.log('    If this hangs, Firebase quota is likely still exhausted — wait for daily reset.');
  let snap;
  try {
    snap = await withTimeout(firestore.collection('kv').get(), 60_000, 'firestore kv.get');
  } catch (e) {
    console.error('FAIL Firebase read:', e.message);
    if (String(e.message).includes('RESOURCE_EXHAUSTED') || String(e.message).includes('Quota')) {
      console.error('→ Firebase free read quota is empty. Wait until it resets, then run again.');
    }
    await client.close().catch(() => {});
    process.exit(1);
  }

  console.log(`[6] Found ${snap.size} documents`);
  if (snap.size === 0) {
    console.log('Nothing to migrate (empty kv). Check Firebase Console → Firestore → kv');
    await client.close();
    process.exit(0);
  }

  let ok = 0;
  let skip = 0;
  let batch = [];

  async function flush() {
    if (!batch.length) return;
    await mongoCol.bulkWrite(batch, { ordered: false });
    ok += batch.length;
    console.log(`  written ${ok}/${snap.size}`);
    batch = [];
  }

  for (const doc of snap.docs) {
    const key = fromDocId(doc.id);
    const data = doc.data() || {};
    if (!('value' in data)) {
      skip++;
      continue;
    }
    batch.push({
      updateOne: {
        filter: { _id: key },
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
    if (batch.length >= 50) {
      try {
        await flush();
      } catch (e) {
        console.error('bulkWrite error:', e.message);
        batch = [];
      }
    }
  }
  try {
    await flush();
  } catch (e) {
    console.error('final bulkWrite error:', e.message);
  }

  const count = await mongoCol.countDocuments();
  console.log('----------');
  console.log(`Done. approx writes=${ok} skipped=${skip}`);
  console.log(`Mongo kv count=${count}`);
  console.log('Next: restart bot, confirm "Database initialized (mongodb)", then remove FIREBASE_SERVICE_ACCOUNT');

  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
