/**
 * Empties this PC's own database before an exact copy of the cloud is loaded.
 * P62, called by load-data.ps1 after it has taken a snapshot.
 *
 *   node box\windows\drop-local-database.mjs "mongodb://127.0.0.1:27017/restaurant-erp?replicaSet=rs0"
 *
 * Refuses any address that is not this PC: it must never reach a cloud database.
 */
import { MongoClient } from 'mongodb';

const uri = process.argv[2] || '';
let url;
try {
  url = new URL(uri);
} catch {
  console.error('Give the local MONGO_URI.');
  process.exit(2);
}
if (url.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  console.error(`Refusing: ${url.hostname} is not this PC.`);
  process.exit(2);
}
const name = url.pathname.replace(/^\//, '');
if (!name) {
  console.error('The address names no database.');
  process.exit(2);
}
const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 10_000 });
try {
  await client.db(name).dropDatabase();
  console.log(`Emptied ${name} on this PC.`);
} finally {
  await client.close();
}
