/**
 * The printers installed on the restaurant PC. 2026-11-03, for the Printers screen.
 *
 * The box server runs on that PC, so it can ask Windows which printers it has and
 * which driver each uses: the screen then says whether the bill printer's driver is
 * in. A fixed command with no input from the request. Anywhere but Windows (the
 * cloud server, a test machine) the list is empty.
 */
import { execFile } from 'node:child_process';

const COMMAND =
  "Get-Printer | Select-Object Name, DriverName, PortName, @{n='Status';e={[string]$_.PrinterStatus}} | ConvertTo-Json -Compress";

function powershellJson(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch {
        resolve(null);
      }
    });
  });
}

/** [{ name, driverName, portName, status }], or null when Windows could not be asked. */
export async function listInstalledPrinters() {
  if (process.platform !== 'win32') return [];
  const raw = await powershellJson(COMMAND);
  if (raw === null) return null;
  return (Array.isArray(raw) ? raw : [raw]).map((printer) => ({
    name: printer.Name,
    driverName: printer.DriverName ?? null,
    portName: printer.PortName ?? null,
    status: printer.Status ?? null,
  }));
}
