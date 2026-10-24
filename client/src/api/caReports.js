/**
 * The CA's month. P65, docs/API-CONTRACT.md "P65" section 4. OWNER only on the
 * server.
 */
import { api, downloadFile } from './client.js';

export const getCaSends = () => api.get('/reports/ca/sends');

export const sendCaPack = (month) => api.post('/reports/ca/send', { month });

/** The month's pack as a workbook: `{ blob, fileName }`. */
export const downloadCaWorkbook = (month) => downloadFile(`/reports/v2/ca-pack?month=${encodeURIComponent(month)}&format=xlsx`);

/** The month's Tally XML: `{ blob, fileName }`. */
export const downloadCaTallyXml = (month) => downloadFile(`/reports/ca/tally-xml?month=${encodeURIComponent(month)}`);
