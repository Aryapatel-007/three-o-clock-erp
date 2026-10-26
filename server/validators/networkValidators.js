/**
 * P62. The network routes' input. API-CONTRACT P62 section 4.
 */
import { z } from 'zod';

const noQuery = z.object({}).strict();

/** POST /network/report: a device's id, its name and its last pings to the box. */
export const networkReportSchema = z.object({
  body: z
    .object({
      deviceId: z.string().trim().min(8, 'Must be at least 8 characters.').max(64, 'Must be at most 64 characters.'),
      deviceName: z.string().trim().max(40, 'Must be at most 40 characters.').optional(),
      page: z.string().trim().max(60).optional(),
      pingsMs: z.array(z.number().min(0).max(60_000).nullable()).max(30, 'At most 30 pings.'),
      effectiveType: z.string().trim().max(10).optional(),
      downlinkMbps: z.number().min(0).max(10_000).optional(),
    })
    .strict(),
});

export const networkReadSchema = z.object({ query: noQuery });

/** POST /network/wifi/connect and PUT /network/staff-wifi. */
const wifiBody = z
  .object({
    ssid: z.string().trim().min(1, 'Choose a WiFi name.').max(32, 'At most 32 characters.'),
    password: z.string().max(63, 'At most 63 characters.').optional().default(''),
  })
  .strict();

export const wifiConnectSchema = z.object({ body: wifiBody });
export const staffWifiSchema = z.object({ body: wifiBody });
