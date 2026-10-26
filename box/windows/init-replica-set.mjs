// P62. Turns the local MongoDB into a single-node replica set, once. Run by install.ps1.
// Bills are numbered inside a transaction, and a standalone MongoDB cannot run one.
// Uses the driver the server already installed, so no mongosh is needed on the PC.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
const { MongoClient } = require('mongodb');

const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', { serverSelectionTimeoutMS: 20_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await client.connect();
  const admin = client.db('admin');
  try {
    await admin.command({ replSetGetStatus: 1 });
    console.log('The replica set already exists.');
  } catch (error) {
    if (error.code !== 94 && error.codeName !== 'NotYetInitialized') throw error;
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
    console.log('Replica set rs0 started.');
  }
  for (let i = 0; i < 60; i += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) {
      console.log('MongoDB is ready.');
      process.exit(0);
    }
    await sleep(1000);
  }
  throw new Error('MongoDB did not become ready within a minute.');
} catch (error) {
  console.error(`MongoDB could not be set up: ${error.message}`);
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
