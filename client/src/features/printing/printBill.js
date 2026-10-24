/**
 * Prints one bill on this device's printer. P25 Part C.
 *
 * A thermal printer prints the thermal bill and A4 and A5 the full-page tax
 * invoice, both laid out from GET /bills/:billId/invoice, with the review
 * link's QR code. The bill screen, the receipt preview and the counter's
 * print queue all print through here, so a bill looks the same whoever prints
 * it.
 */
import { fetchLogoDataUrl } from '../../api/brand.js';
import { getInvoice, markBillPrinted } from '../../api/bills.js';

import { invoiceHtml, invoiceStyles, THERMAL_BILL_STYLES, thermalBillHtml } from './invoiceHtml.js';
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
 * P64. The signature image, as a `data:` URL, only when the bill's layout
 * prints the signature line and a signature is set. Kept by its hash, so a
 * counter printing forty bills fetches it once.
 */
const signatures = new Map();

export function signatureDataUrl(data) {
  const hash = data?.signature?.hash;
  if (!hash || !data.layout?.show?.signatureLine) return Promise.resolve(null);
  if (!signatures.has(hash)) signatures.set(hash, fetchLogoDataUrl('SIGNATURE').catch(() => null));
  return signatures.get(hash);
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
export async function printBill(billId, { printer, logoDataUrl = null, forRequestAt = null, copy = 'RECIPIENT' }) {
  const data = await getInvoice(billId);
  let document;
  if (PRINTERS[printer]?.thermal === false) {
    // P64. The restaurant's theme, its signature, and which copy this is.
    const [qrSvg, signature] = await Promise.all([reviewQrSvg(data.reviewLinkUrl), signatureDataUrl(data)]);
    document = {
      printer,
      bodyHtml: invoiceHtml(data, { qrSvg, logoDataUrl, signatureDataUrl: signature, copy }),
      styles: invoiceStyles(data.layout?.theme),
    };
  } else {
    // 2026-10-09: a thermal bill is laid out from the invoice data too, in the layout guests know.
    const [qrSvg, logo] = await Promise.all([reviewQrSvg(data.reviewLinkUrl), thermalLogoDataUrl(logoDataUrl)]);
    document = { printer, bodyHtml: thermalBillHtml(data, { printer, logoDataUrl: logo, qrSvg, textSize: readDeviceSettings().billTextSize }), styles: THERMAL_BILL_STYLES };
  }
  if (!forRequestAt) {
    await printDocument(document);
    return markBillPrinted(billId);
  }
  let recorded;
  try {
    recorded = await markBillPrinted(billId, { forRequestAt });
  } catch (error) {
    if (error?.code === 'DUPLICATE') return null;
    throw error;
  }
  await printDocument(document);
  return recorded;
}
