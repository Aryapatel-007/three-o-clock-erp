/**
 * A report as an Excel workbook. M19, built in P14. Contract section 5.
 *
 * Built from the envelope the engine already made, never queried a second
 * time, so the file cannot disagree with the screen. Four sheets: Report,
 * Filter, Definitions and Checks. Money is a number in rupees with two
 * decimals and the Indian number format, so the file adds up in Excel.
 */
import ExcelJS from 'exceljs';

import { config } from '../../config/env.js';
import { formatTimeIst12 } from '../../utils/time.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Indian grouping: 1,00,000.00 and 2,07,179.00. */
export const INDIAN_MONEY_FORMAT = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';

/** Plain meanings for the Definitions sheet, by column type. The label itself is the glossary term. */
const TYPE_WORDS = {
  money: 'Rupees, two decimals.',
  count: 'A count.',
  percent: 'A percent, two decimals.',
  text: 'Text.',
  date: 'A business date.',
  time: 'India time.',
  minutes: 'Minutes.',
  decimal2: 'A number, two decimals.',
};

/** One cell's value as Excel should hold it. */
function cellValue(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'money') return value / 100;
  if (type === 'percent') return value / 100;
  if (type === 'decimal2') return value / 100;
  if (type === 'date') {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  if (type === 'time') return formatTimeIst12(value);
  return value;
}

function writeTable(sheet, columns, rows, totals) {
  sheet.addRow(columns.map((column) => column.label)).font = { bold: true };
  for (const row of rows) {
    sheet.addRow(columns.map((column) => cellValue(column.type, row[column.key])));
  }
  if (totals) {
    const totalRow = sheet.addRow(
      columns.map((column, index) => (index === 0 ? 'Total' : column.type === 'money' || column.type === 'count' ? cellValue(column.type, totals[column.key]) : null)),
    );
    totalRow.font = { bold: true };
  }
  columns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = Math.max(12, column.label.length + 2);
    if (column.type === 'money') excelColumn.numFmt = INDIAN_MONEY_FORMAT;
    if (column.type === 'percent' || column.type === 'decimal2') excelColumn.numFmt = '0.00';
    if (column.type === 'date') excelColumn.numFmt = 'dd mmm yyyy';
  });
}

/** The workbook as a Buffer. */
export async function buildWorkbook(envelope) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Dakaar';
  workbook.created = new Date(envelope.generatedAt);

  const failed = envelope.checks.filter((check) => !check.passed && check.severity === 'ERROR');
  const heading = (sheet, title) => {
    sheet.addRow([title]).font = { bold: true, size: 14 };
    sheet.addRow([envelope.filterSentence]);
    if (failed.length > 0) {
      sheet.addRow([`Check failed: ${failed.map((check) => check.message).join(' ')}`]).font = { bold: true, color: { argb: 'FFC0392B' } };
    }
    sheet.addRow([]);
  };

  const allColumns = [];
  // R9: each section is its own sheet, named by its title, as the accountant's import expects.
  if (envelope.sheetPerSection) {
    for (const section of envelope.sections) {
      const sheet = workbook.addWorksheet(section.title);
      heading(sheet, section.title);
      writeTable(sheet, section.columns ?? [], section.rows ?? [], section.totals);
      allColumns.push(...(section.columns ?? []));
    }
  }
  const report = envelope.sheetPerSection ? null : workbook.addWorksheet('Report');
  if (report) heading(report, envelope.title);

  if (envelope.sheetPerSection) {
    // Written above.
  } else if (envelope.sections) {
    for (const section of envelope.sections) {
      report.addRow([section.title ?? section.key]).font = { bold: true };
      writeTable(report, section.columns ?? [], section.rows ?? [], section.totals);
      report.addRow([]);
      allColumns.push(...(section.columns ?? []));
    }
  } else {
    writeTable(report, envelope.columns, envelope.rows, envelope.totals);
    allColumns.push(...envelope.columns);
  }

  const filter = workbook.addWorksheet('Filter');
  filter.addRow(['Filter sentence', envelope.filterSentence]);
  filter.addRow(['Open days', envelope.openDays.length ? envelope.openDays.join(', ') : 'None']);
  filter.addRow(['Generated at', `${formatTimeIst12(envelope.generatedAt)} (${config.DISPLAY_TIMEZONE})`]);
  filter.getColumn(1).width = 18;
  filter.getColumn(2).width = 90;

  const definitions = workbook.addWorksheet('Definitions');
  definitions.addRow(['Column', 'What it holds']).font = { bold: true };
  const seen = new Set();
  for (const column of allColumns) {
    if (seen.has(column.label)) continue;
    seen.add(column.label);
    definitions.addRow([column.label, `${TYPE_WORDS[column.type] ?? ''} Defined in the glossary under "${column.label}".`]);
  }
  definitions.getColumn(1).width = 26;
  definitions.getColumn(2).width = 80;

  const checks = workbook.addWorksheet('Checks');
  checks.addRow(['Check', 'Severity', 'Result', 'Message']).font = { bold: true };
  for (const check of envelope.checks) {
    checks.addRow([check.id, check.severity, check.passed ? 'Passed' : 'Failed', check.message]);
  }
  checks.getColumn(4).width = 100;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** `{restaurant}-{report}-{from}-{to}.xlsx`, spaces and slashes replaced. */
export function workbookFileName(restaurantName, envelope) {
  const from = envelope.filter.from ?? envelope.filter.date;
  const to = envelope.filter.to ?? envelope.filter.date;
  return `${restaurantName}-${envelope.report}-${from}-${to}.xlsx`.replace(/[\s/\\]+/g, '-');
}

export default { buildWorkbook, workbookFileName, XLSX_CONTENT_TYPE };
