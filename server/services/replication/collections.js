/**
 * The collection names `config/replication.js` classifies, by model. P62.
 *
 * The classification is by model name, which a reader recognises; the change
 * stream and the mirror work in collection names. This is the one place that
 * turns one into the other, from the registry itself.
 */
import { MIRROR_MODEL_NAMES } from '../../config/replication.js';
import { ALL_MODELS } from '../../models/index.js';

const byName = new Map(ALL_MODELS.map((model) => [model.modelName, model]));

/** Collection names of every MIRROR model, sorted. */
export function mirrorCollectionNames() {
  return MIRROR_MODEL_NAMES.map((name) => byName.get(name).collection.collectionName).sort();
}

/** True when a collection ships. Anything not named is local: safe by default. */
export function isMirrorCollection(collectionName) {
  return mirrorCollectionNames().includes(collectionName);
}

/** `restaurants` is the tenant itself: its own _id is its restaurantId. */
export const TENANT_COLLECTION = 'restaurants';
