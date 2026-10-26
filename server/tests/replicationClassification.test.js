/**
 * P62 section 3. The tripwire: every model is classified, and nothing else is.
 *
 * A new model cannot be quietly left out of the cloud copy or the backup. The
 * same shape as the `skipTenantGuard` count and the report-definitions test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIRROR_MODEL_NAMES, OWNER, REPLICATION, SYNC } from '../config/replication.js';
import { ALL_MODELS } from '../models/index.js';
import { mirrorCollectionNames } from '../services/replication/collections.js';

/** What is wrong between a list of model names and a classification table. */
export function classificationProblems(modelNames, table) {
  const problems = [];
  for (const name of modelNames) if (!table[name]) problems.push(`${name} is not classified in config/replication.js.`);
  for (const name of Object.keys(table)) if (!modelNames.includes(name)) problems.push(`${name} is classified but no such model exists.`);
  for (const [name, entry] of Object.entries(table)) {
    if (!Object.values(SYNC).includes(entry.sync)) problems.push(`${name} has no valid sync.`);
    if (!Object.values(OWNER).includes(entry.owner)) problems.push(`${name} has no valid owner.`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 5) problems.push(`${name} has no reason.`);
  }
  return problems;
}

const modelNames = ALL_MODELS.map((model) => model.modelName);

describe('the replication classification', () => {
  it('names every model exactly once, with a sync, an owner and a reason', () => {
    assert.deepEqual(classificationProblems(modelNames, REPLICATION), []);
  });

  it('fails when a model is added and not classified', () => {
    const problems = classificationProblems([...modelNames, 'NewThing'], REPLICATION);
    assert.deepEqual(problems, ['NewThing is not classified in config/replication.js.']);
  });

  it('fails when it names a model that does not exist', () => {
    const problems = classificationProblems(modelNames.filter((name) => name !== 'Bill'), REPLICATION);
    assert.deepEqual(problems, ['Bill is classified but no such model exists.']);
  });

  it('ships the money, the people and the counters, and keeps sessions and its own state local', () => {
    for (const name of ['Bill', 'Order', 'Kot', 'User', 'Counter', 'AuditLog', 'DayClosure', 'StockMovement', 'Restaurant', 'IntegrationJob']) {
      assert.equal(REPLICATION[name].sync, SYNC.MIRROR, name);
    }
    for (const name of ['RefreshToken', 'ChangelogEntry', 'ChangelogCounter', 'ReplicationState', 'IntakeItem', 'ReplicaCursor']) {
      assert.equal(REPLICATION[name].sync, SYNC.LOCAL_ONLY, name);
    }
    assert.ok(MIRROR_MODEL_NAMES.includes('Bill'));
  });

  it('turns the shipped models into collection names the change stream can match', () => {
    const names = mirrorCollectionNames();
    assert.ok(names.includes('bills'));
    assert.ok(names.includes('restaurants'));
    assert.ok(!names.includes('changelog'));
    assert.ok(!names.includes('refreshtokens'));
    assert.ok(!names.includes('intake'));
  });
});
