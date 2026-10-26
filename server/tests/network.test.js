/**
 * P62 network additions: the box's WiFi, the devices connected to it and the
 * strength of each, the staff setup details, and changing the WiFi.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { linkQuality as clientLinkQuality, LINK_THRESHOLDS as CLIENT_THRESHOLDS } from '../../client/src/utils/linkQuality.js';
import { setRoleForTest } from '../config/deployment.js';
import { ALL_MODELS } from '../models/index.js';
import { clearDevicesForTest, describeUserAgent } from '../services/network/devicePresence.js';
import { LINK_THRESHOLDS, linkQuality } from '../services/network/linkQuality.js';
import { setNetworkDirForTest } from '../services/network/networkStore.js';
import {
  parseMacSummary,
  parseNetshInterfaces,
  parseNetshNetworks,
  parseNmcliDevices,
  parseNmcliWifiList,
  signalWords,
  splitNmcliLine,
} from '../services/network/wifiService.js';
import { seedTeam } from './helpers/m2Fixtures.js';
import { startTestDatabase, stopTestDatabase } from './helpers/testDatabase.js';
import { request, startTestServer, stopTestServer } from './helpers/testServer.js';

let dir;

before(async () => {
  await startTestDatabase();
  await startTestServer();
  for (const model of ALL_MODELS) await model.init();
  dir = await mkdtemp(path.join(os.tmpdir(), 'cafezza-network-'));
  setNetworkDirForTest(dir);
});

after(async () => {
  setRoleForTest(null);
  await rm(dir, { recursive: true, force: true });
  await stopTestServer();
  await stopTestDatabase();
});

afterEach(() => {
  setRoleForTest(null);
  clearDevicesForTest();
});

describe('link strength', () => {
  it('reads the round trip, the wobble and the losses into bars and a word', () => {
    assert.deepEqual(linkQuality([3, 4, 3, 5, 4, 3]), { bars: 4, word: 'Excellent', medianMs: 4, jitterMs: 1, lossPercent: 0 });
    assert.equal(linkQuality([60, 70, 80, 90]).word, 'Good');
    assert.equal(linkQuality([3, 3, 3, 3, 3, 3, 3, 3, 3, null]).word, 'Fair');
    assert.equal(linkQuality([400, 500, null, 450]).word, 'Weak');
    assert.equal(linkQuality([null, null, null]).word, 'No connection');
    assert.equal(linkQuality([]).bars, 0);
  });

  it('is the same scale on the server and on every device', () => {
    assert.deepEqual(CLIENT_THRESHOLDS, LINK_THRESHOLDS);
    for (const samples of [[3, 4], [90, 120, null], [null], [250, 251, 249], []]) {
      assert.deepEqual(clientLinkQuality(samples), linkQuality(samples));
    }
  });

  it('names a device from its browser when it has no name', () => {
    assert.equal(describeUserAgent('Mozilla/5.0 (Linux; Android 13; SM-T220) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'Android · Chrome');
    assert.equal(describeUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'iPad · Safari');
  });
});

describe("reading the box's WiFi from the operating system's own tools", () => {
  it('reads nmcli, with its escaped colons', () => {
    assert.deepEqual(splitNmcliLine('*:Cafe\\: Staff:82:WPA2'), ['*', 'Cafe: Staff', '82', 'WPA2']);
    assert.deepEqual(parseNmcliDevices('wlan0:wifi:connected:Cafe Staff\neth0:ethernet:unavailable:\n'), [
      { device: 'wlan0', type: 'wifi', state: 'connected', connection: 'Cafe Staff' },
      { device: 'eth0', type: 'ethernet', state: 'unavailable', connection: '' },
    ]);
    const list = parseNmcliWifiList(' :Guest WiFi:40:WPA2\n*:Cafe Staff:82:WPA2\n :Cafe Staff:60:WPA2\n :Open Cafe:30:--\n');
    assert.deepEqual(list.map((network) => [network.ssid, network.signalPercent, network.inUse, network.secured]), [
      ['Cafe Staff', 82, true, true],
      ['Guest WiFi', 40, false, true],
      ['Open Cafe', 30, false, false],
    ]);
  });

  it('reads netsh on Windows', () => {
    const interfaces = parseNetshInterfaces('    Name                   : Wi-Fi\r\n    State                  : connected\r\n    SSID                   : Cafe Staff\r\n    Signal                 : 91%\r\n');
    assert.deepEqual(interfaces, { interface: 'Wi-Fi', connected: true, ssid: 'Cafe Staff', signalPercent: 91 });
    const networks = parseNetshNetworks('SSID 1 : Cafe Staff\r\n    Authentication          : WPA2-Personal\r\n         Signal             : 88%\r\nSSID 2 : Open Cafe\r\n    Authentication          : Open\r\n         Signal             : 40%\r\n');
    assert.deepEqual(networks.map((network) => [network.ssid, network.signalPercent, network.secured]), [['Cafe Staff', 88, true], ['Open Cafe', 40, false]]);
  });

  it('reads macOS', () => {
    assert.equal(parseMacSummary('<dictionary> {\n  SSID : Cafe Staff\n  Security : WPA2\n}'), 'Cafe Staff');
    assert.equal(parseMacSummary('<dictionary> {\n  SSID : <redacted>\n}'), null);
  });

  it('puts the box signal in the same words as the devices', () => {
    assert.equal(signalWords(82).word, 'Excellent');
    assert.equal(signalWords(40).word, 'Fair');
    assert.equal(signalWords(null).word, 'Unknown');
  });
});

describe('the address staff open follows the box to another WiFi', () => {
  it('is the private LAN address of the WiFi or wired adapter, with the port', async () => {
    const { lanUrls } = await import('../services/network/networkStatusService.js');
    const addresses = [
      { interface: 'utun3', address: '100.64.0.2' },
      { interface: 'bridge100', address: '192.168.64.1' },
      { interface: 'en0', address: '10.98.97.69' },
    ];
    const urls = lanUrls({ port: 5050, addresses, host: 'Cafe-Mac.local', fixedUrl: null, fixedName: null });
    assert.equal(urls.boxUrl, 'http://10.98.97.69:5050');
    assert.equal(urls.localNameUrl, 'http://Cafe-Mac.local:5050');
    assert.deepEqual(urls.otherUrls, ['http://192.168.64.1:5050']);
    assert.equal(urls.addressFixed, false);
    const moved = lanUrls({ port: 80, addresses: [{ interface: 'wlan0', address: '192.168.0.23' }], host: 'cafe-server', fixedUrl: null, fixedName: null });
    assert.equal(moved.boxUrl, 'http://192.168.0.23');
    assert.equal(moved.localNameUrl, 'http://cafe-server.local');
    assert.equal(lanUrls({ addresses, fixedUrl: 'http://192.168.1.10', fixedName: null }).boxUrl, 'http://192.168.1.10');
  });
});

describe('the network routes', () => {
  const report = (token, body) => request('POST', '/api/v1/network/report', { token, body });

  it('answers a ping and the setup details without a sign-in, and never says a password', async () => {
    const team = await seedTeam();
    assert.equal((await request('GET', '/api/v1/network/ping')).status, 200);
    await request('PUT', '/api/v1/network/staff-wifi', { token: team.tokens.OWNER, body: { ssid: 'Cafe Staff', password: 'chai-and-samosa' } });
    const setup = await request('GET', '/api/v1/network/setup');
    assert.equal(setup.status, 200);
    assert.equal(setup.body.data.wifiName, 'Cafe Staff');
    assert.ok(!JSON.stringify(setup.body).includes('chai-and-samosa'));
  });

  it("lists every device that reported, with its strength, for the owner and the manager only", async () => {
    const team = await seedTeam();
    assert.equal((await report(team.tokens.WAITER, { deviceId: 'tablet-0001', deviceName: 'Captain tab 1', pingsMs: [3, 4, 3, 5] })).status, 200);
    assert.equal((await report(team.tokens.KITCHEN, { deviceId: 'kitchen-0001', pingsMs: [180, 220, null, 240, 200] })).status, 200);

    const status = await request('GET', '/api/v1/network/status', { token: team.tokens.MANAGER });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    const devices = status.body.data.devices;
    assert.deepEqual(devices.map((device) => [device.name, device.word, device.role]), [
      ['Device · Browser', 'Weak', 'KITCHEN'],
      ['Captain tab 1', 'Excellent', 'WAITER'],
    ]);
    assert.ok(devices.every((device) => device.connected));
    // The setup card's password is for the people who print it.
    await request('PUT', '/api/v1/network/staff-wifi', { token: team.tokens.OWNER, body: { ssid: 'Cafe Staff', password: 'chai-and-samosa' } });
    const again = await request('GET', '/api/v1/network/status', { token: team.tokens.MANAGER });
    assert.deepEqual(again.body.data.staffWifi, { ssid: 'Cafe Staff', password: 'chai-and-samosa' });

    assert.equal((await request('GET', '/api/v1/network/status', { token: team.tokens.WAITER })).status, 403);
    assert.equal((await report(null, { deviceId: 'tablet-0001', pingsMs: [3] })).status, 401);
  });

  it("keeps one restaurant's devices from another's", async () => {
    const first = await seedTeam();
    const second = await seedTeam();
    await report(first.tokens.WAITER, { deviceId: 'tablet-first', pingsMs: [3] });
    const status = await request('GET', '/api/v1/network/status', { token: second.tokens.OWNER });
    assert.deepEqual(status.body.data.devices, []);
  });

  it('tells every signed-in person whether this server may write and how the copy is doing', async () => {
    const team = await seedTeam();
    setRoleForTest('BOX');
    const self = await request('GET', '/api/v1/network/self', { token: team.tokens.WAITER });
    assert.equal(self.status, 200);
    assert.equal(self.body.data.role, 'BOX');
    assert.equal(self.body.data.writer.fenced, false);
    assert.equal(self.body.data.clock.refusing, false);
    // MIRROR_URL is not set under test, so nothing ships, and the staff view says so without the details.
    assert.deepEqual(Object.keys(self.body.data.sync).sort(), ['entriesWaiting', 'state']);
    assert.equal(self.body.data.sync.state, 'LOCAL_ONLY');
    const owner = await request('GET', '/api/v1/network/self', { token: team.tokens.OWNER });
    assert.ok('reconcile' in owner.body.data.sync);
  });

  it('changes the WiFi only on the box, only for the owner, and only when switched on', async () => {
    const team = await seedTeam();
    const body = { ssid: 'New Cafe WiFi', password: 'password123' };
    assert.equal((await request('POST', '/api/v1/network/wifi/connect', { token: team.tokens.OWNER, body })).status, 404);
    setRoleForTest('BOX');
    assert.equal((await request('POST', '/api/v1/network/wifi/connect', { token: team.tokens.MANAGER, body })).status, 403);
    const off = await request('POST', '/api/v1/network/wifi/connect', { token: team.tokens.OWNER, body });
    assert.equal(off.status, 422);
    assert.equal(off.body.error.code, 'WIFI_CONTROL_OFF');
  });
});
