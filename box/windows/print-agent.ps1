# Cafe POS: keeps the hidden printer window running on the cafe PC. 2026-10-22, at
# Rishi's word, then Arya's: a captain's one tap prints the bill, with nobody at the
# counter and no window on the screen.
#
# Run hidden (print-agent.vbs) by the "CafePOS Printer" task when anyone signs in to
# Windows, and again every minute. It opens /print-station, which prints every
# captain's bill on this PC's default printer (the Rugtek) with no dialog, in the
# till's own browser profile (start-till.ps1): the same --kiosk-printing, and the
# same sign-in, so signing in once on the till is enough. Once that window is
# signed in (its title is "Cafe POS printer") it is hidden: no window, no taskbar
# button. Until then it stays on screen, so someone can sign in there.
# Chrome cannot print to a printer from a headless browser, hence a hidden window.
# Written in plain ASCII for Windows PowerShell 5.1.

$ErrorActionPreference = 'SilentlyContinue'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'start-till.ps1')

$PrinterTitle = 'Cafe POS printer'
# The same window before anyone has signed in: left on screen for a sign-in, never opened twice.
$SignInTitle = 'Cafe POS printer - sign in'
# Not opened again sooner than this while it loads, so windows never pile up.
$RelaunchAfterMinutes = 2
$Marker = Join-Path $TillProfile 'printer-window-opened.txt'

$port = 80
$line = Select-String -Path (Join-Path $Root '.env') -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($line) { $port = [int]$line.Matches[0].Groups[1].Value }
$portPart = if ($port -eq 80) { '' } else { ":$port" }
# The page is opened at localhost, where staff sign in; the check asks 127.0.0.1, since
# Windows tries localhost as IPv6 first and the server listens on IPv4 only.
$page = "http://localhost$portPart/print-station?till=1"
$probe = "http://127.0.0.1$portPart/api/v1/network/ping"

Add-Type -ErrorAction SilentlyContinue @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CafePosWindows {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static List<IntPtr> Titled(HashSet<uint> pids, string title) {
    var found = new List<IntPtr>();
    EnumWindows((hWnd, l) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (!pids.Contains(pid)) return true;
      var text = new StringBuilder(256);
      GetWindowText(hWnd, text, 256);
      if (text.ToString() == title) found.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

function Get-PrinterWindows([string]$Title = $PrinterTitle) {
  $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
    Where-Object { $_.CommandLine -like "*$TillProfile*" } |
    ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }
  if ($pids.Count -eq 0) { return @() }
  return [CafePosWindows]::Titled($pids, $Title)
}

function Hide-PrinterWindows {
  $windows = Get-PrinterWindows
  # 0: SW_HIDE. Hidden, not minimized: the flags in start-till.ps1 keep it printing.
  foreach ($window in $windows) { [void][CafePosWindows]::ShowWindow($window, 0) }
  return $windows.Count
}

# Already running and signed in: keep it hidden.
if ((Hide-PrinterWindows) -gt 0) { exit 0 }

# The server not answering yet (the PC just started): the next minute tries again.
try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $probe).StatusCode -eq 200 } catch { $up = $false }
if (-not $up) { exit 0 }

# On screen, waiting for someone to sign in: leave it be.
if (@(Get-PrinterWindows $SignInTitle).Count -gt 0) { exit 0 }

# Opened a moment ago and still loading: leave it be.
if (Test-Path $Marker) {
  $openedAt = (Get-Item $Marker).LastWriteTime
  if ((Get-Date) -lt $openedAt.AddMinutes($RelaunchAfterMinutes)) { exit 0 }
}

if (-not (Open-Till $page -App)) { exit 1 }
New-Item -ItemType File -Force -Path $Marker | Out-Null

# Signed in already (the till's session): it takes its title within seconds; hide it then.
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if ((Hide-PrinterWindows) -gt 0) { exit 0 }
}
