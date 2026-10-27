/**
 * Before two-way sync is switched on: does the website take this PC's secret, and
 * does it already hold this PC's restaurant? Called by connect-website.ps1.
 * P63, docs/WINDOWS-INSTALL.md section 5c.
 *
 *   node box\windows\check-website.mjs "<local MONGO_URI>" "https://<website server>" "<REPLICATION_SECRET>"
 *
 * It sends one signed pull per restaurant on this PC, asking for one change, and
 * prints one line of JSON. The website answers a wrong secret with
 * REPLICATION_SIGNATURE, and a restaurant it has never seen with newestSeq 0:
 * that PC was not loaded from the website's copy, and syncing it would put a
 * second restaurant on Atlas. Reads only this PC's database, and writes nothing
 * here; the website only notes that the PC called.
 */
import { createHmac } from 'node:crypto';

import { BSON, MongoClient } from 'mongodb';

const [uri = '', website = '', secret = ''] = process.argv.slice(2);
const done = (result, code = 0) => {
  console.log(JSON.stringify(result));
  process.exit(code);
};

let url;
try {
  url = new URL(uri);
} catch {
  done({ ok: false, reason: 'LOCAL_URI', message: 'Give the local MONGO_URI.' }, 2);
}
if (url.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
  done({ ok: false, reason: 'LOCAL_URI', message: `Refusing: ${url.hostname} is not this PC.` }, 2);
}
if (!/^(https:\/\/[^/]+|http:\/\/127\.0\.0\.1:\d+)$/.test(website)) done({ ok: false, reason: 'WEBSITE', message: 'The website address must be https:// with no slash at the end.' }, 2);
if (secret.length < 32) done({ ok: false, reason: 'SECRET', message: 'The secret is shorter than 32 characters: copy all of it from Render.' }, 2);

const name = url.pathname.replace(/^\//, '');
const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 10_000 });
let restaurants;
try {
  restaurants = await client.db(name).collection('restaurants').find({}, { projection: { name: 1 } }).toArray();
} finally {
  await client.close();
}
if (restaurants.length === 0) done({ ok: false, reason: 'NO_DATA', message: 'This PC has no restaurant yet. Run "Load cafe data" first.' }, 1);

const results = [];
for (const restaurant of restaurants) {
  const text = BSON.EJSON.stringify({ restaurantId: restaurant._id, afterSeq: 0, limit: 1 }, { relaxed: false });
  let response;
  try {
    response = await fetch(`${website}/api/v1/replication/pull`, {
      method: 'POST',
      headers: {
        'content-type': 'application/ejson',
        'x-replication-signature': `sha256=${createHmac('sha256', secret).update(text, 'utf8').digest('hex')}`,
      },
      body: text,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    done({ ok: false, reason: 'UNREACHABLE', message: `The website did not answer: ${error.message}` }, 1);
  }
  const body = await response.json().catch(() => ({}));
  if (body?.error?.code === 'REPLICATION_SIGNATURE') {
    done({ ok: false, reason: 'SECRET', message: 'The website refused the secret. Copy REPLICATION_SECRET again from Render, Environment.' }, 1);
  }
  if (response.status === 404) {
    done({ ok: false, reason: 'NOT_TWO_WAY', message: 'The website does not have two-way sync on: set SYNC_MODE=TWO_WAY on Render first.' }, 1);
  }
  if (!body?.success) done({ ok: false, reason: 'WEBSITE', message: body?.error?.message || `The website answered ${response.status}.` }, 1);
  results.push({ name: restaurant.name, newestSeq: body.data.newestSeq });
}

const unknown = results.filter((result) => !result.newestSeq);
if (unknown.length > 0) {
  done({
    ok: false,
    reason: 'NOT_THE_SAME_DATA',
    message: `The website has never seen ${unknown.map((r) => `"${r.name}"`).join(', ')} from this PC. Load a fresh copy of the website's data with "Load cafe data" first.`,
    results,
  }, 1);
}
done({ ok: true, results });
