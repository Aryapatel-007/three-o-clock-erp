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

/** Served over https: the website, not the cafe PC (plain http on the cafe WiFi). */
function websitePage() {
  return typeof window !== 'undefined' && window.location?.protocol === 'https:';
}

const DEFAULTS = Object.freeze({
  // P25. THERMAL_80, THERMAL_58, A4 or A5. Replaced P05's `paperMm`, which a
  // device that saved one is moved from on its next load.
  printer: DEFAULT_PRINTER,
  // 2026-10-09. BILL or ROLL: how long a thermal page is. printers.js says why.
  // 2026-10-22: on the cafe PC (plain http) every device starts on what prints with no gap above on the
  // Rugtek (CAFE_PC_PAPER). 2026-10-27: on the website (https) a page exactly the bill's size, which any
  // printer and Save as PDF print as the bill; the roll left it in the corner of a whole sheet there.
  paperLength: websitePage() ? 'BILL' : 'ROLL',
  // 2026-10-09. SMALL, NORMAL or LARGE: the thermal bill's text, from invoiceHtml.js.
  billTextSize: DEFAULT_BILL_TEXT_SIZE,
  // 2026-10-09. NONE, SMALL or MORE: space kept clear at each side of a roll, from printers.js.
  edgeMargin: 'MORE',
  // 2026-10-10. WIDE (78 mm) or STANDARD (72 mm): the 80 mm roll's printed width, from printers.js.
  printWidth: 'STANDARD',
  autoPrintKots: false,
  // P25 Part D. A counter computer prints the bills captains send it.
  printCaptainBills: false,
  // 2026-10-27. The counter prints every new KOT, on any screen (CounterKotPrinter).
  printKotsAtCounter: false,
  // 2026-10-25. Where a bill printed from this device comes out: AUTO, HERE or COUNTER (billsPrintAtCounter).
  billPrintsAt: 'AUTO',
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
  // 2026-10-27. A device made after the roll setup below needs none: it starts on that paper.
  rollSetup: 2,
});

export const BILL_PRINT_PLACES = Object.freeze(['AUTO', 'HERE', 'COUNTER']);

/**
 * 2026-10-25. Whether a bill printed from this device goes to the counter's
 * printer, as a captain's does (API-CONTRACT M3 16.3), instead of this device's.
 *
 * On the cafe PC the bill printer is on the PC itself, and only the till window
 * prints captains' bills (`printCaptainBills`). A manager's or cashier's phone
 * there printed to nothing: Print bill opened the phone's own printing, and no
 * bill came out (Z Chaat, 2026-10-25). So, automatically, every device on the
 * cafe PC's server but the till window, or one that prints captains' bills,
 * sends to the counter. On the website it stays this device, as before. This device can
 * choose either.
 */
export function billsPrintAtCounter(device, features, { small = smallScreen() } = {}) {
  if (device?.billPrintsAt === 'COUNTER') return true;
  if (device?.billPrintsAt === 'HERE') return false;
  // The till window (?till=1) always prints here: it is the counter.
  if (device?.cafeTill || device?.printCaptainBills) return false;
  if (features?.sync?.server === 'BOX') return true;
  // 2026-10-27, Three O'Clock: on the website too, an owner's, manager's or
  // cashier's phone or tablet has no bill printer, so it prints at the counter as
  // a captain's does. A computer's screen keeps printing on its own printer.
  return small;
}

/** A phone or tablet: narrower than a counter computer's screen. */
function smallScreen() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches;
}

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
  const billPrintsAt = BILL_PRINT_PLACES.includes(rest.billPrintsAt) ? rest.billPrintsAt : 'AUTO';
  return { ...rest, printer: printerFor(stored), paperLength, billTextSize, edgeMargin, printWidth, billPrintsAt };
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
/**
 * What prints best on Z Chaat's Rugtek, measured on the website's counter: the
 * printer's roll, 72 mm, 4 mm each side. The cafe PC's hidden printer window
 * always prints with it, whatever This device holds, since nobody can open its
 * This device (PrintStationPage).
 */
export const CAFE_PC_PAPER = Object.freeze({ paperLength: 'ROLL', printWidth: 'STANDARD', edgeMargin: 'MORE' });

// 3: only the hidden printer window (PrintStationPage, which prints whatever this switch says)
// prints captains' bills, always on CAFE_PC_PAPER. At 1 every browser on the PC did, and a plain
// Chrome window showed the print dialog; at 2 the till did too, on its own paper, and left blank
// paper above the bill (Arya, 2026-10-22). 4: the same paper once more on every device on the PC.
// 5: the till prints captains' bills again, on CAFE_PC_PAPER (AppShell): the hidden printer window
// printed nothing, as Chrome holds back printing from a hidden page.
const CAFE_PC_PRINT_SETUP = 5;

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
 * with no dialog (--kiosk-printing): it prints captains' bills. Marked once as
 * the app loads, before any screen changes the address.
 */
// 2: the till also prints every new KOT (2026-10-27, Three O'Clock): one printer at the counter.
const TILL_SETUP = 2;

function markCafeTill() {
  const stored = readStored() ?? lastWritten ?? {};
  if (stored.cafeTill && (stored.tillSetup ?? 1) >= TILL_SETUP) return;
  write({
    ...stored,
    cafeTill: true,
    printCaptainBills: true,
    printKotsAtCounter: true,
    counterKotsArmedAt: Date.now(),
    tillSetup: TILL_SETUP,
  });
}

/**
 * 2026-10-27. Z Chaat's paper on every device, the website's included, once: the
 * printer's roll, 72 mm wide, 4 mm each side, Normal text (CAFE_PC_PAPER), which
 * the defaults above already give a new device. A device set up before them kept
 * 78 mm and no edge, and cut the right side of the bill and the KOT. A later
 * choice on This device is kept.
 */
const ROLL_SETUP = DEFAULTS.rollSetup;

// 2: on the website the page is the bill's own size (paperLength BILL), the width and edge as Z Chaat's.
function applyRollSetup() {
  const stored = readStored();
  if (!stored || (stored.rollSetup ?? 0) >= ROLL_SETUP) return;
  const paper = websitePage() ? { ...CAFE_PC_PAPER, paperLength: 'BILL' } : CAFE_PC_PAPER;
  write({ ...stored, ...paper, billTextSize: 'NORMAL', rollSetup: ROLL_SETUP });
}

if (typeof window !== 'undefined' && window.location) {
  applyRollSetup();
  if (new URLSearchParams(window.location.search).get('till') === '1') markCafeTill();
}

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
