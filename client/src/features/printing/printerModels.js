/**
 * The printers restaurants in India use, each with the settings that print its bill
 * best and where its Windows driver comes from. 2026-11-03, for the Printers screen.
 *
 * `settings` are This device's printer settings (useDeviceSettings): the paper,
 * the print width on an 80 mm roll, the edge margin, the bill's text size and the
 * paper length. Most 80 mm heads print 72 mm (576 dots at 203 dpi), so STANDARD;
 * the Rugtek's are the ones measured on Z Chaat's printer (CAFE_PC_PAPER).
 *
 * `driverKeywords` are matched, without case, against the driver names Windows
 * reports (GET /system/printers), to say whether this model's driver is installed.
 */
const THERMAL_80 = { printer: 'THERMAL_80', printWidth: 'STANDARD', edgeMargin: 'NONE', billTextSize: 'NORMAL', paperLength: 'BILL' };
const THERMAL_58 = { printer: 'THERMAL_58', printWidth: 'STANDARD', edgeMargin: 'NONE', billTextSize: 'NORMAL', paperLength: 'BILL' };

const search = (words) => `https://www.google.com/search?q=${encodeURIComponent(`${words} printer driver download Windows`)}`;

export const PRINTER_BRANDS = Object.freeze([
  {
    brand: 'Epson',
    site: 'https://download.epson-biz.com/modules/pos/',
    models: [
      { id: 'epson-tm-t82', name: 'TM-T82X / TM-T82III (80 mm)', settings: THERMAL_80, driverName: 'Epson Advanced Printer Driver (APD)', driverKeywords: ['epson', 'tm-t82'] },
      { id: 'epson-tm-t88', name: 'TM-T88VI / TM-T88VII (80 mm)', settings: THERMAL_80, driverName: 'Epson Advanced Printer Driver (APD)', driverKeywords: ['epson', 'tm-t88'] },
      { id: 'epson-tm-t20', name: 'TM-T20III (80 mm)', settings: THERMAL_80, driverName: 'Epson Advanced Printer Driver (APD)', driverKeywords: ['epson', 'tm-t20'] },
    ],
  },
  {
    brand: 'TVS Electronics',
    site: 'https://www.tvs-e.in/',
    models: [
      { id: 'tvs-rp3200', name: 'RP 3200 Plus / Star (80 mm)', settings: THERMAL_80, driverName: 'TVS RP 3200 driver', driverKeywords: ['tvs', 'rp 3200', 'rp3200'] },
      { id: 'tvs-rp3230', name: 'RP 3230 / RP 3220 (80 mm)', settings: THERMAL_80, driverName: 'TVS RP 3230 driver', driverKeywords: ['tvs', 'rp 3230', 'rp3230', 'rp 3220'] },
      { id: 'tvs-rp3160', name: 'RP 3160 Gold / Star (80 mm)', settings: THERMAL_80, driverName: 'TVS RP 3160 driver', driverKeywords: ['tvs', 'rp 3160', 'rp3160'] },
      { id: 'tvs-rp45', name: 'RP 45 Shoppe (58 mm)', settings: THERMAL_58, driverName: 'TVS RP 45 driver', driverKeywords: ['tvs', 'rp 45', 'rp45'] },
    ],
  },
  {
    brand: 'Rugtek',
    site: 'https://www.rugtek.com/',
    models: [
      {
        id: 'rugtek-rp326',
        name: 'RP326 / RP80 (80 mm)',
        settings: { printer: 'THERMAL_80', printWidth: 'STANDARD', edgeMargin: 'MORE', billTextSize: 'NORMAL', paperLength: 'ROLL' },
        driverName: 'POS-80 driver (from the Rugtek CD or website)',
        driverKeywords: ['rugtek', 'pos-80', 'pos80', 'rp326'],
      },
      { id: 'rugtek-rp58', name: 'RP58 (58 mm)', settings: THERMAL_58, driverName: 'POS-58 driver', driverKeywords: ['rugtek', 'pos-58', 'pos58'] },
    ],
  },
  {
    brand: 'Xprinter',
    site: 'https://www.xprintertech.com/',
    models: [
      { id: 'xprinter-xp80', name: 'XP-80C / XP-N160II (80 mm)', settings: THERMAL_80, driverName: 'Xprinter POS-80 driver', driverKeywords: ['xprinter', 'xp-80', 'xp80', 'pos-80'] },
      { id: 'xprinter-xp58', name: 'XP-58IIH / XP-58 (58 mm)', settings: THERMAL_58, driverName: 'Xprinter POS-58 driver', driverKeywords: ['xprinter', 'xp-58', 'xp58', 'pos-58'] },
    ],
  },
  {
    brand: 'Posiflex',
    site: 'https://www.posiflex.com/',
    models: [{ id: 'posiflex-pp8800', name: 'PP8800 / Aura PP6900 (80 mm)', settings: THERMAL_80, driverName: 'Posiflex PP printer driver', driverKeywords: ['posiflex', 'pp8800', 'pp6900', 'aura'] }],
  },
  {
    brand: 'Star Micronics',
    site: 'https://starmicronics.com/support/',
    models: [{ id: 'star-tsp143', name: 'TSP143IV / TSP100 (80 mm)', settings: THERMAL_80, driverName: 'Star futurePRNT / TSP100 driver', driverKeywords: ['star', 'tsp1'] }],
  },
  {
    brand: 'Citizen',
    site: 'https://www.citizen-systems.co.jp/english/support/download/',
    models: [{ id: 'citizen-cts310', name: 'CT-S310II / CT-D150 (80 mm)', settings: THERMAL_80, driverName: 'Citizen POS printer driver', driverKeywords: ['citizen', 'ct-s310', 'ct-d150'] }],
  },
  {
    brand: 'Bixolon',
    site: 'https://www.bixolon.com/',
    models: [{ id: 'bixolon-srp350', name: 'SRP-350III / SRP-330II (80 mm)', settings: THERMAL_80, driverName: 'Bixolon SRP Windows driver', driverKeywords: ['bixolon', 'srp-3'] }],
  },
  {
    brand: 'Office printer',
    site: null,
    models: [
      { id: 'office-a4', name: 'Any A4 printer (laser or inkjet)', settings: { printer: 'A4' }, driverName: "The printer maker's driver", driverKeywords: [] },
      { id: 'office-a5', name: 'Any printer with A5 paper', settings: { printer: 'A5' }, driverName: "The printer maker's driver", driverKeywords: [] },
    ],
  },
]);

export const OTHER_MODEL_ID = 'other';

export function findModel(id) {
  for (const brand of PRINTER_BRANDS) {
    const model = brand.models.find((candidate) => candidate.id === id);
    if (model) return { ...model, brand: brand.brand, site: brand.site, searchUrl: search(`${brand.brand} ${model.name.split(' (')[0]}`) };
  }
  return null;
}

/** The installed Windows printers whose driver looks like this model's. */
export function matchingPrinters(model, installed = []) {
  if (!model?.driverKeywords?.length) return [];
  return installed.filter((printer) => {
    const text = `${printer.name} ${printer.driverName ?? ''}`.toLowerCase();
    return model.driverKeywords.some((word) => text.includes(word));
  });
}

/** A sample bill for "Print a test bill": the real thermal layout, nothing saved anywhere. */
export function testBillData({ restaurantName = 'Your restaurant' } = {}) {
  const lines = [
    { itemName: 'Masala Chai', variantName: null, quantity: 2, unitPriceInPaise: 3000, lineTotalInPaise: 6000, addOnNames: [], notes: null },
    { itemName: 'Paneer Butter Masala with a long name to test wrapping', variantName: null, quantity: 1, unitPriceInPaise: 28000, lineTotalInPaise: 28000, addOnNames: ['Extra butter'], notes: 'Less spicy' },
    { itemName: 'Butter Naan', variantName: null, quantity: 3, unitPriceInPaise: 6000, lineTotalInPaise: 18000, addOnNames: [], notes: null },
    { itemName: 'Cold Coffee', variantName: 'Large', quantity: 1, unitPriceInPaise: 16000, lineTotalInPaise: 16000, addOnNames: [], notes: null },
  ];
  const itemTotal = lines.reduce((sum, line) => sum + line.lineTotalInPaise, 0);
  const tax = Math.round(itemTotal * 0.025);
  const total = itemTotal + tax * 2;
  const rounded = Math.round(total / 100) * 100;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    restaurant: { name: restaurantName, legalName: null, headerAbove: null, headerLines: ['TEST PRINT'], addressLines: ['This is a test bill, not a tax invoice'], phone: null, gstin: null, fssaiNumber: null },
    issuedAtIst: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    orderType: 'DINE_IN',
    tableName: 'T-1',
    platform: null,
    cashierName: 'Test',
    billNumber: 'TEST-0001',
    isDuplicate: false,
    isVoided: false,
    isRevised: false,
    captainName: null,
    guestCount: 2,
    customer: null,
    itemRows: lines,
    lines,
    taxRows: [{ taxRateBps: 500, cgstInPaise: tax, sgstInPaise: tax }],
    itemTotalInPaise: itemTotal,
    discount: null,
    roundOffInPaise: rounded - total,
    billTotalInPaise: rounded,
    billTotalInWords: null,
    payments: [],
    accountName: null,
    footerText: 'Test print: if every line is complete and nothing is cut off, this printer is ready.',
    layout: { thermalShow: {} },
  };
}
