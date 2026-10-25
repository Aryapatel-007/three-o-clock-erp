/**
 * 2026-10-25. Where a bill printed from a device comes out
 * (client/src/features/printing/useDeviceSettings.js billsPrintAtCounter).
 * A manager's or cashier's phone on the cafe PC has no bill printer, so its
 * bills go to the counter; the till window and the counter printer print here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { billsPrintAtCounter } from '../../client/src/features/printing/useDeviceSettings.js';

const BOX = { sync: { server: 'BOX' } };
const CLOUD = { sync: { server: 'CLOUD' } };

describe('billsPrintAtCounter', () => {
  it('on the cafe PC, a phone sends its bills to the counter', () => {
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'AUTO' }, BOX), true);
  });

  it('on the cafe PC, the till window and the counter printer print here', () => {
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'AUTO', cafeTill: true }, BOX), false);
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'AUTO', printCaptainBills: true }, BOX), false);
  });

  it('on the website, a device prints here unless it chose the counter', () => {
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'AUTO' }, CLOUD), false);
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'COUNTER' }, CLOUD), true);
  });

  it('a choice on This device wins over Automatic', () => {
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'HERE' }, BOX), false);
    assert.equal(billsPrintAtCounter({ billPrintsAt: 'COUNTER', cafeTill: true }, BOX), true);
  });
});
