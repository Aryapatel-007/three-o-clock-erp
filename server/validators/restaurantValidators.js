/**
 * Restaurant request schemas.
 */
import { z } from 'zod';

import { nonEmptyString, phoneIndia } from './common.js';

/** 15 characters, uppercase alphanumeric. */
const gstin = z
  .string({ error: 'Is required.' })
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-Z]{15}$/, 'Must be exactly 15 letters and digits.');

/** 14 digits. */
const fssaiLicenseNumber = z
  .string({ error: 'Is required.' })
  .trim()
  .regex(/^\d{14}$/, 'Must be exactly 14 digits.');

/** P64. A PAN, AAAAA9999A, or null to clear it. */
const panNumber = z.union([
  z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'A PAN is 5 letters, 4 digits and a letter, like AAAPZ1234C.'),
  z.null(),
], { error: 'A PAN is 5 letters, 4 digits and a letter, like AAAPZ1234C.' });

/** P64. An Udyam (MSME) number, UDYAM-GJ-01-0012345, or null to clear it. */
const msmeNumber = z.union([
  z.string().trim().toUpperCase().regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, 'An Udyam number looks like UDYAM-GJ-01-0012345.'),
  z.null(),
], { error: 'An Udyam number looks like UDYAM-GJ-01-0012345.' });

const pincode = z
  .string({ error: 'Is required.' })
  .trim()
  .regex(/^\d{6}$/, 'Must be exactly 6 digits.');

const email = z
  .string({ error: 'Is required.' })
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Must be an email address.');

const address = z.object({
  line1: nonEmptyString.optional(),
  line2: nonEmptyString.optional(),
  city: nonEmptyString.optional(),
  state: nonEmptyString.optional(),
  pincode: pincode.optional(),
});

/**
 * Restaurant settings. Added by M5 (decision log, D1).
 *
 * One key for now. Sending `settings` replaces the whole object on the way
 * through `$set`; that is fine with a single key and is M3's to make partial
 * when it adds `settings.tax`.
 */
const settings = z
  .object({
    businessDayStartsAtMinutes: z
      .number({ error: 'Must be a whole number of minutes.' })
      .int('Must be a whole number of minutes past midnight.')
      .min(0, 'Cannot be negative.')
      .max(1439, 'Cannot be more than 1439, which is 23:59.'),
  })
  .strict('Is not a setting you can change here.');

/**
 * PATCH /restaurant.
 *
 * Every field optional, at least one present. A PATCH with an empty body is
 * almost always a client bug, and answering 200 to it hides that.
 *
 * `isActive` is absent on purpose and rejected if sent. Deactivating a
 * restaurant is a platform operation, not something a customer does to
 * themselves through their own settings screen. `.strict()` is what turns a
 * stray isActive into an error rather than a silently ignored field.
 */
export const updateRestaurantSchema = z.object({
  body: z
    .object({
      name: nonEmptyString.optional(),
      legalName: nonEmptyString.optional(),
      gstin: gstin.optional(),
      fssaiLicenseNumber: fssaiLicenseNumber.optional(),
      panNumber: panNumber.optional(),
      msmeNumber: msmeNumber.optional(),
      contactPhone: phoneIndia.optional(),
      contactEmail: email.optional(),
      address: address.optional(),
      settings: settings.optional(),
    })
    .strict('Is not a field you can change here.')
    .refine(
      (body) => Object.keys(body).length > 0,
      'Send at least one field to change.',
    ),
});
