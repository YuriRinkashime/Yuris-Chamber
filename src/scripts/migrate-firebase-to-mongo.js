/**
 * One-time migration: Firebase Firestore `kv` → MongoDB Atlas `kv`
 *
 * Usage (on Bot-Hosting or local, with BOTH env vars set):
 *   node src/scripts/migrate-firebase-to-mongo.js
 *
 * Requires:
 *   FIREBASE_SERVICE_ACCOUNT  (JSON string)
 *   MONGODB_URI
 * Optional:
 *   MONGODB_DB=yuris_chamber
 *
 * After success, set DB_DRIVER=mongodb and remove FIREBASE_SERVICE_ACCOUNT.
 */

import admin from 'firebase-admin';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const firebaseRaw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!uri) {
  console.error('Missing MONGODB_URI');
  process.exit(1);
}
if (!firebaseRaw) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT (needed only for this migration)');
  process.exit(1);
}

let cred;
try {
  cred = typeof firebaseRaw === 'string' ? JSON.parse(firebaseRaw) : firebaseRaw;
} catch {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
  process.exit(1);
}

function fromDocId(id) {
  try {
    return decodeURIComponent(String(id));
  } catch {
    return String(id);
  }
}

async function main() {
  console.log('Connecting Firebase...');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(cred) });
  }
  const firestore = admin.firestore();
  const fbCol = firestore.collection('kv');

  console.log('Connecting MongoDB...');
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
  console.log(`Mongo target: db=${dbName} collection=kv`);

  console.log('Reading all Firebase kv documents (this may take a minute)...');
  const snap = await fbCol.get();
  console.log(`Found ${snap.size} documents`);

  let ok = 0;
  let skip = 0;
  let fail = 0;
  const batch = [];

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

    if (batch.length >= 100) {
      try {
        await mongoCol.bulkWrite(batch, { ordered: false });
        ok += batch.length;
        console.log(`  written ${ok}/${snap.size}...`);
      } catch (e) {
        fail += batch.length;
        console.error('  bulkWrite error:', e.message);
      }
      batch.length = 0;
    }
  }

  if (batch.length) {
    try {
      await mongoCol.bulkWrite(batch, { ordered: false });
      ok += batch.length;
    } catch (e) {
      fail += batch.length;
      console.error('  bulkWrite error:', e.message);
    }
  }

  const count = await mongoCol.countDocuments();
  console.log('----------');
  console.log(`Done. Migrated writes: ~${ok}, skipped: ${skip}, failed batches: ${fail}`);
  console.log(`Mongo kv document count: ${count}`);
  console.log('Next: set DB_DRIVER=mongodb, restart bot, then remove FIREBASE_SERVICE_ACCOUNT');

  await client.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
