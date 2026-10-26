/**
 * P63. The cloud half of two-way sync, as its own process, for twoWaySyncE2e.test.js.
 *
 *   node --env-file=.env.test tests/helpers/twoWayCloudProcess.js
 *
 * The test passes MONGO_URI (a second database on the test replica set),
 * DEPLOYMENT_ROLE=CLOUD, SYNC_MODE=TWO_WAY and REPLICATION_SECRET in the
 * environment, which win over .env.test. It serves the real app, runs the real
 * changelog writer, and prints "READY <port>" once both are up.
 */
import mongoose from 'mongoose';

import { httpLogger, logger } from '../../config/logger.js';
import { ALL_MODELS } from '../../models/index.js';
import { createApp } from '../../server.js';
import { startReplication, stopReplication } from '../../services/replication/runtime.js';

logger.level = process.env.TWO_WAY_CLOUD_LOG ?? 'silent';
httpLogger.logger.level = logger.level;

await mongoose.connect(process.env.MONGO_URI);
for (const model of ALL_MODELS) await model.init();
await startReplication();
const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
process.stdout.write(`READY ${server.address().port}\n`);

async function stop() {
  await stopReplication().catch(() => {});
  server.close();
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
