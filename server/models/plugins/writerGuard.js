/**
 * The single-writer rule, enforced where a write happens. P62 section 8.
 *
 * Every model that applies the tenant guard applies this through it. A write
 * to a MIRROR-classified model (config/replication.js) throws before it reaches
 * the database when this machine is not the writer:
 *
 *   - the cloud mirror, until a person promotes it  -> MIRROR_READ_ONLY
 *   - a box that saw a higher epoch and stood down  -> WRITER_FENCED
 *   - a box whose clock went behind its last record -> CLOCK_BEHIND
 *
 * The HTTP guard (middleware/writerGate.js) refuses the request first, with
 * the same words. This is the layer underneath, for anything that writes
 * without a request: a job, a timer, a script. The way the rule fails is two
 * bills with the same GST invoice number, so it is checked twice.
 *
 * LOCAL_ONLY models (sessions, intake, replication's own state) are untouched:
 * a mirror must still sign people in and take intake.
 *
 * The replication receiver writes the copy through the driver, below this.
 */
import { REPLICATION, SYNC } from '../../config/replication.js';
import { ClockBehindError, MirrorReadOnlyError, WriterFencedError } from '../../utils/errors.js';
import { clockIsRefusing } from '../../services/replication/clockGuard.js';
import { boxIsFenced, mirrorIsReadOnly } from '../../services/replication/writerState.js';
import { isBox } from '../../config/deployment.js';

const QUERY_WRITES = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
];

/** The error to throw for a write to `modelName` now, or null when it may go ahead. */
export function writeRefusal(modelName) {
  if (REPLICATION[modelName]?.sync !== SYNC.MIRROR) return null;
  if (mirrorIsReadOnly()) return new MirrorReadOnlyError();
  if (boxIsFenced()) return new WriterFencedError();
  if (isBox() && clockIsRefusing()) return new ClockBehindError();
  return null;
}

function refuse(modelName) {
  const error = writeRefusal(modelName);
  if (error) throw error;
}

export function writerGuardPlugin(schema) {
  for (const operation of QUERY_WRITES) {
    schema.pre(operation, { query: true, document: false }, function guardQueryWrite() {
      refuse(this.model?.modelName);
    });
  }
  schema.pre('deleteOne', { query: false, document: true }, function guardDocumentDelete() {
    refuse(this.constructor?.modelName);
  });
  // Before validation too: a refused write should say why, not that a field is missing.
  schema.pre('validate', function guardValidate() {
    refuse(this.constructor?.modelName);
  });
  schema.pre('save', function guardSave() {
    refuse(this.constructor?.modelName);
  });
  schema.pre('insertMany', function guardInsertMany() {
    refuse(this.modelName);
  });
  schema.pre('bulkWrite', function guardBulkWrite() {
    refuse(this.modelName);
  });
}

export default writerGuardPlugin;
