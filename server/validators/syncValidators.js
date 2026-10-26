/**
 * P63. Request shapes for the sync routes.
 */
import { z } from 'zod';

import { objectId, paginationQuery, queryBoolean } from './common.js';

export const syncStatusSchema = z.object({ query: z.object({}).strict() });

export const syncConflictsSchema = z.object({
  query: paginationQuery.extend({ seen: queryBoolean.optional() }).strict(),
});

export const conflictSeenSchema = z.object({
  params: z.object({ conflictId: objectId }),
  body: z.object({}).strict().optional(),
});

/** 2026-10-22. LOCAL: the side that found it; INCOMING: the other side; RESULT: as merged. */
export const conflictKeepSchema = z.object({
  params: z.object({ conflictId: objectId }),
  body: z.object({ version: z.enum(['LOCAL', 'INCOMING', 'RESULT']) }).strict(),
});

export const syncNowSchema = z.object({ body: z.object({}).strict().optional() });

export const syncChangesSchema = z.object({ query: z.object({}).strict() });

export const syncChangeUndoSchema = z.object({
  params: z.object({ changeId: z.string().regex(/^[a-f0-9]{24}$/, 'Must be a change id.') }),
  body: z.object({}).strict().optional(),
});
