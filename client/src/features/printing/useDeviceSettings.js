import { useCallback, useEffect, useState } from 'react';

import {
  BILL_TEXT_SIZES,
  DEFAULT_BILL_TEXT_SIZE,
  DEFAULT_EDGE_MARGIN,
  DEFAULT_PAPER_LENGTH,
  DEFAULT_PRINT_WIDTH,
  DEFAULT_PRINTER,
  EDGE_MARGINS,
  PAPER_LENGTHS,
  PRINT_WIDTHS,
  printerFor,
} from './printers.js';

/**
 * Settings that belong to this device, not to a user or the restaurant. P05.
 *
 * The cashier's computer has an 80mm printer whoever signs in, and a station
 * tablet prints its own tickets. So the printer, auto-print and the kitchen
 * screen's chosen station live in this browser's localStorage, under one key,
 * read through this one hook.
 *
 * Nothing here is security or money. Losing it costs a click to set again.
 */
// Named before P25 for the first client. Kept: renaming it would forget every
// device's printer, station and look, and nobody ever sees it.
const STORAGE_KEY = 'caffeza.device';

/** How many printed KOT ids to remember, so a refresh never prints twice. */
export const PRINTED_KOT_MEMORY = 500;

/** P20A, DESIGN-SYSTEM section 11b. */
export const THEMES = Object.freeze(['AUTO', 'DAY', 'NIGHT']);
export const DENSITIES = Object.freeze(['COMFORTABLE', 'COMPACT']);
export const TEXT_SIZES = Object.freeze([100, 115, 130]);

const DEFAULTS = Object.freeze({
  // P25. THERMAL_80, THERMAL_58, A4 or A5. Replaced P05's `paperMm`, which a
  // device that saved one is moved from on its next load.
  printer: DEFAULT_PRINTER,
  // 2026-10-09. BILL or ROLL: how long a thermal page is. printers.js says why.
  paperLength: DEFAULT_PAPER_LENGTH,
  // 2026-10-09. SMALL, NORMAL or LARGE: the thermal bill's text, from invoiceHtml.js.
  billTextSize: DEFAULT_BILL_TEXT_SIZE,
  // 2026-10-09. NONE, SMALL or MORE: space kept clear at each side of a roll, from printers.js.
  edgeMargin: DEFAULT_EDGE_MARGIN,
  // 2026-10-10. WIDE (78 mm) or STANDARD (72 mm): the 80 mm roll's printed width, from printers.js.
  printWidth: DEFAULT_PRINT_WIDTH,
  autoPrintKots: false,
  // P25 Part D. A counter computer prints the bills captains send it.
  printCaptainBills: false,
  // P29 Part D, retired by P57: Save & Print on the order screen says when to print. Kept so old saved settings still read.
  printBillOnCreate: false,
  printedBillRequests: [],
  // P25 Part I. The card machine on this counter, by its Pine Labs client id.
  terminalClientId: null,
  kitchenStationId: null,
  printedKotIds: [],
  // Automatic is Day everywhere, the kitchen included. Night is chosen per device.
  theme: 'AUTO',
  density: 'COMFORTABLE',
  textSize: 100,
  // null follows the restaurant's `settings.appearance.secondLanguage`.
  secondLanguage: null,
  // P22. The last restaurant signed in here: wordmark, accent pair, tone, brand
  // pair and logos as small data URLs with their hashes. The sign-in screen
  // uses it before anyone signs in, and signing out keeps it. Not secret.
  brand: null,
  // P23. The online alert on this device: the chime and banner, and the spoken line.
  onlineAlerts: true,
  speakAlerts: true,
  // P45. The kitchen screen rings a loud bell for a new ticket. Off unless turned on (Rishi, 2026-10-14).
  kitchenSound: false,
  // How far back the kitchen's Recall looks: 30m, 1h, 3h or day.
  recallRange: '1h',
  // 2026-10-21. The kitchen screen's tiles: BIG, or SMALL in a rush so more tickets fit.
  kitchenTiles: 'BIG',
});

/** Same-tab listeners. The `storage` event only reaches other tabs. */
const CHANGE_EVENT = 'erp-device-change';

/** What this tab last wrote, for a browser that refuses storage. */
let lastWritten = null;

/** Fills in defaults, and moves a device saved before P25 from paper width to a printer. */
function withDefaults(stored) {
  const { paperMm: _legacy, ...rest } = { ...DEFAULTS, ...stored };
  const paperLength = PAPER_LENGTHS[rest.paperLength] ? rest.paperLength : DEFAULT_PAPER_LENGTH;
  const billTextSize = BILL_TEXT_SIZES[rest.billTextSize] ? rest.billTextSize : DEFAULT_BILL_TEXT_SIZE;
  const edgeMargin = EDGE_MARGINS[rest.edgeMargin] ? rest.edgeMargin : DEFAULT_EDGE_MARGIN;
  const printWidth = PRINT_WIDTHS[rest.printWidth] ? rest.printWidth : DEFAULT_PRINT_WIDTH;
  return { ...rest, printer: printerFor(stored), paperLength, billTextSize, edgeMargin, printWidth };
}

function readStored() {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return null;
  }
}

/**
 * 2026-10-22. The cafe PC's bill printer (Z Chaat's Rugtek, driver POS-80) prints
 * on its 80(72.1) x 3276 mm roll and skips the blank after the last line. A page
 * as long as the bill was put at the end of that long page, so a whole page of
 * blank paper came out before every bill, and at 78 mm the right side was cut.
 * Every browser and window keeps its own This device, so setting each by hand
 * missed the one that printed. Signed in to the cafe PC's own server (/auth/me
 * `sync.server` BOX, AuthContext), every device moves once to what prints best
 * on the website's counter (Arya, 2026-10-22): the printer's roll, 72 mm, 4 mm
 * each side, Normal text. The till also prints captains' bills: on the PC it is
 * the one window that prints (box/windows/start-till.ps1). A later choice on
 * This device is kept. The website never runs this.
 */
// 2: only the till prints captains' bills. At 1 every browser on the PC did, and a plain Chrome
// window that took a bill first showed the print dialog instead of printing (Arya, 2026-10-22).
const CAFE_PC_PRINT_SETUP = 2;

export function applyCafePcPrintSetup() {
  const stored = readStored() ?? lastWritten ?? {};
  if ((stored.cafePcPrintSetup ?? 0) >= CAFE_PC_PRINT_SETUP) return;
  write({
    ...stored,
    printer: 'THERMAL_80',
    paperLength: 'ROLL',
    printWidth: 'STANDARD',
    edgeMargin: 'MORE',
    billTextSize: 'NORMAL',
    printCaptainBills: Boolean(stored.cafeTill),
    cafePcPrintSetup: CAFE_PC_PRINT_SETUP,
  });
}

/**
 * The till window that box/windows/start-till.ps1 opens, with ?till=1, prints
 * with no dialog (--kiosk-printing), so it is the one that prints captains'
 * bills. Read once as the app loads, before any screen changes the address.
 */
function markCafeTill() {
  const stored = readStored() ?? lastWritten ?? {};
  if (stored.cafeTill && stored.printCaptainBills) return;
  write({ ...stored, cafeTill: true, printCaptainBills: true });
}

if (typeof window !== 'undefined' && window.location && new URLSearchParams(window.location.search).get('till') === '1') markCafeTill();

function read() {
  return withDefaults(readStored() ?? lastWritten ?? {});
}

/** This device's settings, outside React: the print frame reads the paper length here. */
export function readDeviceSettings() {
  return read();
}

function write(settings) {
  lastWritten = settings;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A private window can refuse storage. The settings just do not stick.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Returns `[settings, update]`. `update` takes a partial object, or a function
 * of the current settings, and saves the result on the device.
 */
export function useDeviceSettings() {
  const [settings, setSettings] = useState(read);

  // P25. A device that saved a paper width keeps the same paper, as a printer, from now on.
  useEffect(() => {
    const stored = readStored();
    if (stored && 'paperMm' in stored) write(read());
  }, []);

  // Another tab on the same device changing a setting is picked up here.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY) setSettings(read());
    };
    const onChange = () => setSettings(read());
    window.addEventListener('storage', onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  // Reads the stored settings rather than this hook's copy, so two screens
  // using the hook never overwrite each other's change.
  const update = useCallback((change) => {
    const current = read();
    const next = { ...current, ...(typeof change === 'function' ? change(current) : change) };
    setSettings(next);
    write(next);
  }, []);

  return [settings, update];
}

/** Adds ids to the printed list, keeping only the most recent ones. */
export function rememberPrinted(printedKotIds, ids) {
  const merged = [...printedKotIds.filter((id) => !ids.includes(id)), ...ids];
  return merged.slice(-PRINTED_KOT_MEMORY);
}
