/**
 * The CA's month. P65, docs/API-CONTRACT.md "P65" section 4.
 */
import { z } from 'zod';

import { MONTH_PATTERN } from '../services/reports/definitions/caPack.js';

const month = z.string({ error: 'Choose a month.' }).regex(MONTH_PATTERN, 'A month like 2026-10.');

export const listCaSendsSchema = z.object({ query: z.object({}).strict('Takes no parameters.') });

export const sendCaPackSchema = z.object({ body: z.object({ month }).strict('Is not a field you can send here.') });

export const caTallyXmlSchema = z.object({ query: z.object({ month }).strict('Is not a parameter here.') });
