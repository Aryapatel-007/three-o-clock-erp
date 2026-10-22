/**
 * Prints one bill on this device's printer. P25 Part C.
 *
 * A thermal printer prints the thermal bill and A4 and A5 the full-page tax
 * invoice, both laid out from GET /bills/:billId/invoice, with the review
 * link's QR code. The bill screen, the receipt preview and the counter's
 * print queue all print through here, so a bill looks the same whoever prints
 * it.
 */
import { getInvoice, markBillPrinted } from '../../api/bills.js';

import { INVOICE_STYLES, invoiceHtml, THERMAL_BILL_STYLES, thermalBillHtml } from './invoiceHtml.js';
import { PRINTERS } from './printers.js';
import { printDocument } from './printText.js';
import { readDeviceSettings } from './useDeviceSettings.js';

/**
 * The review link as an SVG QR code, or null. Built here, never fetched.
 *
 * P32. The QR library loads the first time a bill with a review link prints,
 * not with the app: most bills, and every restaurant without a review link,
 * never need it. It is a few kB, and cached for good once fetched.
 */
export async function reviewQrSvg(url) {
  if (!url) return null;
  const { default: QRCode } = await import('qrcode');
  return QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

/**
 * The logo as pure black on white, for a thermal head, which prints each dot
 * black or not at all: a coloured or grey logo otherwise comes out as a faint
 * dither. Any pixel darker than mid-grey, once laid on white, is black. Null
 * when there is no logo or it cannot be read, so the bill still prints.
 */
export async function thermalLogoDataUrl(dataUrl) {
  if (!dataUrl) return null;
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = pixels;
    for (let index = 0; index < data.length; index += 4) {
      const luminance = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      const value = luminance < 160 ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Prints the bill, then records the print (P25 Part D), so the next print of
 * it, from any device, says Duplicate at the top.
 *
 * P59. With `forRequestAt`, a captain's request from the print queue: the
 * request is claimed on the server after the bill is laid out and before it
 * prints, and only the device whose claim succeeds prints it. Resolves to
 * null when another device took it.
 */
export async function printBill(billId, { printer, logoDataUrl = null, forRequestAt = null, paper = null }) {
  const data = await getInvoice(billId);
  let document;
  if (PRINTERS[printer]?.thermal === false) {
    const qrSvg = await reviewQrSvg(data.reviewLinkUrl);
    document = { printer, bodyHtml: invoiceHtml(data, { qrSvg, logoDataUrl }), styles: INVOICE_STYLES };
  } else {
    // 2026-10-09: a thermal bill is laid out from the invoice data too, in the layout guests know.
    const [qrSvg, logo] = await Promise.all([reviewQrSvg(data.reviewLinkUrl), thermalLogoDataUrl(logoDataUrl)]);
    document = { printer, bodyHtml: thermalBillHtml(data, { printer, logoDataUrl: logo, qrSvg, textSize: readDeviceSettings().billTextSize }), styles: THERMAL_BILL_STYLES };
  }
  if (!forRequestAt) {
    await printDocument({ ...document, paper });
    return markBillPrinted(billId);
  }
  let recorded;
  try {
    recorded = await markBillPrinted(billId, { forRequestAt });
  } catch (error) {
    if (error?.code === 'DUPLICATE') return null;
    throw error;
  }
  await printDocument({ ...document, paper });
  return recorded;
}
