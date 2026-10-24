/**
 * Whether this machine holds a whole period. P65, API-CONTRACT P65 2.
 *
 * Under P62 a read-only mirror is a copy that can lag, and under P63 the cloud
 * receives the cafe PC's days through the sync. A pack built on a copy that has
 * not yet received a month's last change would hand a CA half a month. So on
 * either, the restaurant's cursor must have no gap and have captured at or
 * after the last close of the period. The box, and a plain cloud deployment,
 * are the writer and hold everything they wrote.
 */
import { ReplicaCursor } from '../../models/ReplicaCursor.js';
import { BusinessRuleError } from '../../utils/errors.js';
import { toIst } from '../../utils/time.js';
import { mirrorIsReadOnly } from '../replication/writerState.js';
import { isTwoWayCloud } from '../sync/mode.js';

export async function assertCopyHoldsPeriod(req, closures) {
  if (!mirrorIsReadOnly() && !isTwoWayCloud()) return;
  const lastClose = closures.reduce((latest, closure) => (closure.closedAt && closure.closedAt > latest ? closure.closedAt : latest), new Date(0));
  const cursor = await ReplicaCursor.findOne({ restaurantId: req.restaurantId }).lean();
  const asOf = cursor?.lastCapturedAt ? `Figures are as of ${toIst(cursor.lastCapturedAt)}.` : 'Nothing has arrived yet.';
  if (!cursor || cursor.gap?.expectedSeq != null || !cursor.lastCapturedAt || cursor.lastCapturedAt < lastClose) {
    throw new BusinessRuleError(`This copy has not received the whole month yet. ${asOf}`);
  }
}

export default { assertCopyHoldsPeriod };
