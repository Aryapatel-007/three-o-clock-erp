/**
 * Creates a restaurant, its one branch, and its owner.
 *
 *   npm run provision:restaurant
 *   npm run provision:restaurant -- --name "Shreeji Dining Hall" --owner "Rishi Patel" --phone 9876543210
 *   npm run provision:restaurant -- --name "..." --owner "..." --phone 9876543210 \
 *       --email owner@example.com --password "one you choose"
 *
 * There is no signup endpoint. Accounts are created by this script, run by
 * Arya or Rishi. `--email` sets a second login identity; `--password` sets your
 * own instead of a generated one. It prints the password to the terminal
 * exactly once and never writes it anywhere else.
 *
 * All three documents are created together or not at all. A restaurant with no
 * owner cannot be logged into, and a user with a dangling restaurantId is
 * worse than nothing.
 */
import { randomInt } from 'node:crypto';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import mongoose from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { ROLES } from '../config/roles.js';
import { Branch } from '../models/Branch.js';
import { PaymentMethod } from '../models/PaymentMethod.js';
import { Restaurant } from '../models/Restaurant.js';
import { User } from '../models/User.js';
import { isEmailRegistered, isPhoneRegistered } from '../services/authService.js';
import { hash } from '../services/passwordService.js';
import { ensureDefaultPaymentMethods } from '../services/paymentMethodService.js';
import { MIN_PASSWORD_LENGTH } from '../validators/authValidators.js';
import { normalisePhoneIndia } from '../validators/common.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_BRANCH_NAME = 'Main';
const GENERATED_PASSWORD_LENGTH = 16;

/**
 * No look-alike characters. This gets read off a screen and typed on a phone,
 * and the difference between 0, O, 1, l and I is where that goes wrong.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

export class ProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

function validateInput({ restaurantName, ownerName, ownerPhone, ownerEmail, password }) {
  const name = String(restaurantName ?? '').trim();
  const owner = String(ownerName ?? '').trim();
  const phone = normalisePhoneIndia(String(ownerPhone ?? '').trim());

  if (name.length === 0) throw new ProvisioningError('The restaurant name is required.');
  if (owner.length === 0) throw new ProvisioningError('The owner name is required.');
  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw new ProvisioningError(`"${ownerPhone}" is not a 10 digit Indian mobile number.`);
  }

  const email = String(ownerEmail ?? '').trim().toLowerCase();
  if (email.length > 0 && !EMAIL_PATTERN.test(email)) {
    throw new ProvisioningError(`"${ownerEmail}" is not an email address.`);
  }

  if (password !== undefined && String(password).length < MIN_PASSWORD_LENGTH) {
    throw new ProvisioningError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  return {
    restaurantName: name,
    ownerName: owner,
    ownerPhone: phone,
    ownerEmail: email.length > 0 ? email : null,
  };
}

/**
 * Creates the three documents.
 *
 * `session` is null when the connection cannot do transactions, in which case
 * the caller is responsible for cleaning up on failure.
 */
export async function createRecords(input, { session = null, password, created = {} }) {
  const { restaurantName, ownerName, ownerPhone, ownerEmail } = input;
  const options = session ? { session } : {};

  // Phone numbers are unique across the whole platform, so this check cannot
  // be scoped to a restaurant. authService owns that one lookup.
  if (await isPhoneRegistered(ownerPhone, { session })) {
    throw new ProvisioningError(
      `The phone number ${ownerPhone} is already registered. A phone number identifies exactly one account across the whole platform.`,
    );
  }

  if (ownerEmail && (await isEmailRegistered(ownerEmail, { session }))) {
    throw new ProvisioningError(
      `The email ${ownerEmail} is already registered. An email identifies exactly one account across the whole platform.`,
    );
  }

  const [restaurant] = await Restaurant.create([{ name: restaurantName }], options);
  created.restaurantId = String(restaurant._id);

  const [branch] = await Branch.create(
    [{ restaurantId: restaurant._id, name: DEFAULT_BRANCH_NAME }],
    options,
  );
  created.branchId = String(branch._id);

  const [owner] = await User.create(
    [
      {
        restaurantId: restaurant._id,
        branchId: branch._id,
        name: ownerName,
        phone: ownerPhone,
        ...(ownerEmail ? { email: ownerEmail } : {}),
        passwordHash: await hash(password),
        role: ROLES.OWNER,
      },
    ],
    options,
  );
  created.userId = String(owner._id);

  // P08. Cash, Card, UPI and the inactive Other, inside the same transaction.
  await ensureDefaultPaymentMethods(restaurant._id, { branchId: branch._id, session });

  return {
    restaurantId: String(restaurant._id),
    branchId: String(branch._id),
    userId: String(owner._id),
  };
}

/** A standalone mongod has no replica set, so it cannot do transactions. */
function isTransactionUnsupported(error) {
  const message = String(error?.message ?? '');
  return (
    error?.code === 20 ||
    /Transaction numbers are only allowed on a replica set/i.test(message) ||
    /does not support (?:sessions|transactions)/i.test(message) ||
    /Transactions are not supported/i.test(message)
  );
}

/** Best effort cleanup for the no-transaction path. */
async function rollbackManually(ids) {
  const results = { restaurant: false, branch: false, user: false, paymentMethods: false };
  try {
    // P08. Created last, so removed first. Configuration, never a sale record.
    if (ids.restaurantId) {
      await PaymentMethod.deleteMany({ restaurantId: ids.restaurantId });
      results.paymentMethods = true;
    }
    if (ids.userId) {
      await User.deleteOne({ _id: ids.userId, restaurantId: ids.restaurantId });
      results.user = true;
    }
    if (ids.branchId) {
      await Branch.deleteOne({ _id: ids.branchId, restaurantId: ids.restaurantId });
      results.branch = true;
    }
    if (ids.restaurantId) {
      await Restaurant.deleteOne({ _id: ids.restaurantId });
      results.restaurant = true;
    }
  } catch {
    // Reported by the caller. Nothing useful to do from here.
  }
  return results;
}

/**
 * Runs provisioning, in a transaction where the connection supports one.
 *
 * Atlas and a replica set do. A standalone local mongod does not, and rather
 * than refusing to run there we fall back to creating the three documents in
 * order and undoing them by hand on failure. The caller is told which mode was
 * used, because the guarantees are not the same and pretending otherwise is
 * how a half-created restaurant goes unnoticed.
 */
export async function runProvisioning(rawInput) {
  const input = validateInput(rawInput);
  const chosenPassword =
    typeof rawInput.password === 'string' && rawInput.password.length > 0
      ? rawInput.password
      : null;
  const password = chosenPassword ?? generatePassword();
  const passwordSource = chosenPassword ? 'chosen' : 'generated';

  let session;
  try {
    session = await mongoose.startSession();
  } catch {
    session = null;
  }

  if (session) {
    try {
      let ids;
      await session.withTransaction(async () => {
        ids = await createRecords(input, { session, password });
      });
      return {
        ...ids,
        password,
        passwordSource,
        phone: input.ownerPhone,
        email: input.ownerEmail,
        mode: 'transaction',
      };
    } catch (error) {
      if (!isTransactionUnsupported(error)) throw error;
      // Fall through to the manual path below.
    } finally {
      await session.endSession();
    }
  }

  const created = {};
  try {
    const ids = await createRecords(input, { session: null, password, created });
    return {
      ...ids,
      password,
      passwordSource,
      phone: input.ownerPhone,
      email: input.ownerEmail,
      mode: 'manual',
    };
  } catch (error) {
    const rolledBack = await rollbackManually(created);
    error.rolledBack = rolledBack;
    throw error;
  }
}

function parseArguments(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = /^--(name|owner|phone|email|password)$/.exec(argv[i]);
    if (match) flags[match[1]] = argv[i + 1];
  }
  return flags;
}

async function promptForMissing(flags) {
  const required = [
    ['name', 'Restaurant name'],
    ['owner', 'Owner full name'],
    ['phone', 'Owner mobile number (10 digits)'],
  ].filter(([key]) => !flags[key]);

  const optional = [
    ['email', 'Owner email for login (optional, Enter to skip)'],
    ['password', 'Owner password (optional, Enter to generate one)'],
  ].filter(([key]) => flags[key] === undefined);

  if (required.length === 0 && optional.length === 0) return flags;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answers = { ...flags };
    for (const [key, label] of [...required, ...optional]) {
      const value = (await rl.question(`${label}: `)).trim();
      if (value.length > 0) answers[key] = value;
    }
    return answers;
  } finally {
    rl.close();
  }
}

async function main() {
  const flags = await promptForMissing(parseArguments(process.argv.slice(2)));

  await connectDatabase();

  try {
    const result = await runProvisioning({
      restaurantName: flags.name,
      ownerName: flags.owner,
      ownerPhone: flags.phone,
      ownerEmail: flags.email,
      password: flags.password,
    });

    // The only time this password is ever readable. It is not logged, not
    // written to a file, and cannot be recovered from the database.
    console.log('');
    console.log('  Restaurant created.');
    console.log('');
    console.log(`  restaurantId : ${result.restaurantId}`);
    console.log(`  branchId     : ${result.branchId}`);
    console.log(`  userId       : ${result.userId}`);
    console.log('');
    console.log(`  Sign in with phone : ${result.phone}`);
    if (result.email) console.log(`  or with email      : ${result.email}`);
    console.log(
      `  Password           : ${result.password}${
        result.passwordSource === 'chosen' ? '  (as given)' : '  (generated)'
      }`,
    );
    console.log('');
    console.log('  Write the password down now. It is not stored anywhere and cannot be shown again.');
    console.log(
      result.mode === 'transaction'
        ? '  Created inside a transaction.'
        : '  Created without a transaction, because this connection has no replica set. Rollback on failure was manual.',
    );
    console.log('');
  } catch (error) {
    console.error('');
    console.error(`  Provisioning failed: ${error.message}`);
    if (error.rolledBack) {
      console.error(`  Rolled back: ${JSON.stringify(error.rolledBack)}`);
    }
    console.error('');
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) await main();
