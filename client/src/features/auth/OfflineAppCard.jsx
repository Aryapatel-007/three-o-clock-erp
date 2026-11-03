/**
 * The offline app, offered on the website's sign-in screen: ThreeOClock-Setup.exe
 * installs the whole system on a restaurant's Windows PC, where it runs without
 * the internet (docs/WINDOWS-INSTALL.md). The link is the newest signed release.
 *
 * Shown only on the website. A restaurant PC serves these same screens at a WiFi
 * address (an IP, localhost or a .local name), where the app is already installed.
 */
export const OFFLINE_APP_URL = 'https://github.com/Aryapatel-007/three-o-clock-releases/releases/latest/download/ThreeOClock-Setup.exe';

export function isWebsite(hostname = window.location.hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.local')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) return false;
  return hostname.includes('.');
}

export default function OfflineAppCard() {
  if (!isWebsite()) return null;
  return (
    <section aria-label="Offline app" className="mt-8 rounded-lg border border-line bg-surface p-4">
      <h3 className="type-label text-ink">Install the offline app</h3>
      <p className="type-caption mt-1 text-muted">
        Run Three O’Clock on your restaurant&apos;s Windows PC. Billing, kitchen tickets and printing keep working without the
        internet, and tablets join over the WiFi.
      </p>
      <a
        href={OFFLINE_APP_URL}
        className={[
          'mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg px-4 type-button',
          'border border-ink bg-surface text-ink transition-colors hover:bg-sunken',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        ].join(' ')}
      >
        Download for Windows
      </a>
      <p className="type-caption mt-2 text-muted">Double-click ThreeOClock-Setup.exe and press Enter twice.</p>
    </section>
  );
}
