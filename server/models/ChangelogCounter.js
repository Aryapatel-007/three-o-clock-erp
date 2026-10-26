/**
 * The changelog's own sequence, one document per restaurant. P62.
 *
 * Its own collection, not a `counters` name: `models/Counter.js` is frozen by
 * P62 section 12, and a changelog number must never share a sequence with a
 * bill. Incremented only inside the transaction that inserts the entry, so a
 * failed insert gives its number back and the series has no gaps.
 */
import mongoose from 'mongoose';

import { tenantGuardPlugin } from './plugins/tenantGuard.js';

const changelogCounterSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, required: true },
    value: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: false, versionKey: false },
);

changelogCounterSchema.plugin(tenantGuardPlugin);
changelogCounterSchema.index({ restaurantId: 1 }, { unique: true });

export const ChangelogCounter = mongoose.model('ChangelogCounter', changelogCounterSchema, 'changelogcounters');
