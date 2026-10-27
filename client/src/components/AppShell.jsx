import BillNoSearch from './BillNoSearch.jsx';
import { Suspense, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeProvider.jsx';
import OnlineAlerts, { useAlertsOn, useOnlineInbox } from '../features/online/OnlineAlerts.jsx';
import CaptainBillPrinter from '../features/printing/CaptainBillPrinter.jsx';
import CounterKotPrinter from '../features/printing/CounterKotPrinter.jsx';
import { CAFE_PC_PAPER } from '../features/printing/useDeviceSettings.js';
import { inboxOn } from '../features/online/inboxOn.js';
import BrandLogo from './ui/BrandLogo.jsx';
import {
  BagIcon,
  CashIcon,
  ChartIcon,
  DeviceIcon,
  FloorIcon,
  GlobeIcon,
  HomeIcon,
  KitchenIcon,
  LockIcon,
  MenuBookIcon,
  MoreIcon,
  ReceiptIcon,
  ScooterIcon,
} from './ui/icons/index.jsx';
import AccountMenu, { SignOutButton } from './AccountMenu.jsx';
import LiveConnection from './LiveConnection.jsx';
import ConnectionStatus, { LostConnectionBanner } from '../features/network/ConnectionStatus.jsx';
import SyncBadge from '../features/sync/SyncBadge.jsx';
import Sheet from './ui/Sheet.jsx';
import Spinner from './ui/Spinner.jsx';

/**
 * The frame around every signed-in screen. DESIGN-SYSTEM sections 8a and 9.
 *
 * Under 600px: a top bar with the wordmark, and a bottom bar with the role's
 * main places and More. From 600px: a 76px rail on the left with the same
 * places. Chosen by width, never by device type. More opens a sheet with every
 * other place this person may go, and sign out.
 *
 * Links are conveniences, not permissions. The server refuses each endpoint to
 * the wrong role whether or not a link is drawn, and a switched-off feature is
 * hidden here the same way.
 */
const FULL_SCREEN_PATHS = ['/attendance'];

/** The service screens of DESIGN-SYSTEM section 8a. Everything else is back office. */
const SERVICE_PATHS = ['/floor', '/orders', '/bills', '/kitchen'];
const isServicePath = (pathname) => SERVICE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

const PLACES = {
  home: { to: '/dashboard', label: 'Home', Icon: HomeIcon },
  floor: { to: '/floor', label: 'Floor', Icon: FloorIcon },
  takeaway: { to: '/orders/takeaway', label: 'Takeaway', Icon: BagIcon },
  delivery: { to: '/orders/delivery', label: 'Delivery', Icon: ScooterIcon },
  kitchen: { to: '/kitchen', label: 'Kitchen', Icon: KitchenIcon },
  bills: { to: '/bills', label: 'Bills', Icon: ReceiptIcon },
  cash: { to: '/cash-book', label: 'Cash book', Icon: CashIcon },
  // P44. The manager's place for the end of the day is Day End; /day-close stays for history.
  dayClose: { to: '/day-end', label: 'Day End', Icon: LockIcon },
  reports: { to: '/reports', label: 'Reports', Icon: ChartIcon },
  availability: { to: '/menu/availability', label: 'Availability', Icon: MenuBookIcon },
  stock: { to: '/inventory', label: 'Stock', Icon: MenuBookIcon },
  // P23. Online takeaway and bookings, shown only while the feature is on.
  online: { to: '/online', label: 'Online', Icon: GlobeIcon },
};

/** Each role's four main places, in the order they are used. */
const MAIN_BY_ROLE = {
  OWNER: ['floor', 'bills', 'kitchen', 'reports'],
  MANAGER: ['floor', 'bills', 'kitchen', 'dayClose'],
  CASHIER: ['floor', 'bills', 'takeaway', 'cash'],
  WAITER: ['floor', 'takeaway', 'delivery', 'kitchen'],
  KITCHEN: ['kitchen', 'availability'],
  STOREKEEPER: ['stock', 'availability'],
};

function useMoreGroups() {
  const { user, features } = useAuth();
  const role = user?.role;
  const manager = role === 'OWNER' || role === 'MANAGER';
  const till = manager || role === 'CASHIER';
  const floor = till || role === 'WAITER';
  const inventoryOn = features.inventory !== false;
  const attendanceOn = features.attendance !== false;
  const onlineOn = Boolean(features.online?.enabled);

  const groups = [
    {
      title: 'Service',
      items: [
        { to: '/dashboard', label: 'Home', show: true },
        // P55. The owner's dashboard, outside the ERP.
        { to: '/owner', label: 'Dashboard', show: role === 'OWNER' },
        { to: '/floor', label: 'Floor', show: floor },
        { to: '/orders/takeaway', label: 'Takeaway', show: floor },
        { to: '/orders/delivery', label: 'Delivery', show: floor },
        { to: '/kitchen', label: 'Kitchen', show: true },
        { to: '/bills', label: 'Bills', show: till },
        { to: '/menu/availability', label: 'Availability', show: true },
        { to: '/online', label: 'Online orders', show: floor && inboxOn(features) },
        { to: '/online/bookings', label: 'Bookings', show: floor && onlineOn },
        // P51. WhatsApp chats, for the till.
        { to: '/online/chats', label: 'Chats', show: till && Boolean(features.online?.chats) },
      ],
    },
    {
      title: 'Money',
      items: [
        { to: '/accounts', label: 'On Hold', show: till },
        { to: '/cash-book', label: 'Cash book', show: till },
        // P61. The cashier closes the day too.
        { to: '/day-end', label: 'Day End', show: till },
        { to: '/day-close', label: 'Day Close history', show: manager },
        { to: '/payouts', label: 'Payouts', show: manager },
        { to: '/reports', label: 'Reports', show: manager },
        { to: '/customers', label: 'Customers', show: manager },
      ],
    },
    {
      title: 'Set up',
      items: [
        { to: '/menu', label: 'Menu', show: manager },
        { to: '/tables', label: 'Table setup', show: manager },
        { to: '/stations', label: 'Stations', show: manager },
        { to: '/inventory', label: 'Stock', show: inventoryOn },
        { to: '/staff', label: 'Staff', show: manager },
        { to: '/attendance/register', label: 'Attendance', show: attendanceOn && manager },
        { to: '/attendance/me', label: 'My hours', show: attendanceOn },
        { to: '/settings', label: 'Settings', show: role === 'OWNER' },
        { to: '/settings/integrations', label: 'Integrations', show: manager },
        // P62. The cafe server's WiFi, the devices on it and the cloud copy.
        { to: '/network', label: 'Network and devices', show: manager },
        // P63. Two-way sync with the website, and its conflicts.
        { to: '/sync', label: 'Sync', show: manager && features?.sync?.mode === 'TWO_WAY' },
        { to: '/connect', label: 'Connect a device', show: true },
        { to: '/device', label: 'This device', show: true },
      ],
    },
  ];
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.show) }))
    .filter((group) => group.items.length > 0);
}

/** The till's roles, who get Online beside their main places while it is on. */
const ONLINE_MAIN_ROLES = ['OWNER', 'MANAGER', 'CASHIER'];

function useMainPlaces() {
  const { user, features } = useAuth();
  const keys = [...(MAIN_BY_ROLE[user?.role] ?? ['home'])];
  // P25 Part H. Also while a delivery platform is connected: its orders arrive in the same inbox.
  if (inboxOn(features) && ONLINE_MAIN_ROLES.includes(user?.role)) keys.push('online');
  return keys
    .filter((key) => key !== 'stock' || features.inventory !== false)
    .map((key) => PLACES[key]);
}

const isCurrent = (pathname, to) => pathname === to || (to !== '/dashboard' && pathname.startsWith(`${to}/`) && !(to === '/menu' && pathname.startsWith('/menu/availability')));

/** The waiting count on the Online place, from the same query the alert polls. */
function OnlineBadge() {
  const alertsOn = useAlertsOn();
  const { data } = useOnlineInbox(alertsOn);
  const waiting = data ? data.waitingOrders + data.waitingReservations : 0;
  if (!waiting) return null;
  return (
    <span className="type-caption absolute -right-1 -top-1 flex min-w-5 items-center justify-center rounded-full bg-alert px-1 text-on-accent">
      {waiting}
    </span>
  );
}

function PlaceLink({ place, layout }) {
  const { pathname } = useLocation();
  const active = isCurrent(pathname, place.to) || (place.to === '/floor' && pathname.startsWith('/orders/') && !pathname.startsWith('/orders/takeaway') && !pathname.startsWith('/orders/delivery'));
  const Icon = place.Icon;
  return (
    <NavLink
      to={place.to}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex flex-col items-center justify-center gap-1 rounded-lg transition-colors',
        layout === 'rail' ? 'min-h-14 w-16' : 'min-h-14 flex-1',
        active ? 'bg-sunken text-ink' : 'text-muted hover:bg-sunken hover:text-ink',
      ].join(' ')}
    >
      <span className={`relative ${active ? 'text-accent' : ''}`}>
        <Icon size={22} />
        {place.to === '/online' && <OnlineBadge />}
      </span>
      <span className="type-caption">{place.label}</span>
    </NavLink>
  );
}

function MoreButton({ onClick, layout }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex flex-col items-center justify-center gap-1 rounded-lg text-muted transition-colors hover:bg-sunken hover:text-ink',
        layout === 'rail' ? 'min-h-14 w-16' : 'min-h-14 flex-1',
      ].join(' ')}
    >
      <MoreIcon size={22} />
      <span className="type-caption">More</span>
    </button>
  );
}

function MoreSheet({ onClose }) {
  const { user } = useAuth();
  const groups = useMoreGroups();
  return (
    <Sheet title="All places" subtitle={user ? `${user.name}` : null} onClose={onClose}>
      <nav aria-label="All places" className="flex flex-col gap-4">
        {groups.map((group) => (
          <div key={group.title}>
            <p className="type-label mb-1 text-muted">{group.title}</p>
            <ul className="flex flex-col">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={onClose}
                    end={item.to === '/menu' || item.to === '/bills'}
                    className={({ isActive }) =>
                      ['type-body flex min-h-12 items-center rounded-lg px-3', isActive ? 'bg-sunken font-semibold' : 'hover:bg-sunken'].join(' ')
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <SignOutButton />
      </nav>
    </Sheet>
  );
}

/**
 * The restaurant's mark in the top bar. P22, DESIGN-SYSTEM section 15.
 *
 * On a phone the logo at 32px. From 600px, on a back-office screen, the logo at
 * 40px; on a service screen the rail carries the square mark instead, so a
 * screen shows the brand once. With no logo, the wordmark as text everywhere,
 * exactly as before: the restaurant's wordmark, then its name, then the
 * product's. A client's name is never written into the product.
 */
function TopBarMark({ isService }) {
  const { brand } = useTheme();
  const hasLogo = Boolean(brand.logos?.LIGHT_GROUND?.dataUrl || brand.logos?.DARK_GROUND?.dataUrl);
  return (
    <>
      <BrandLogo height={32} className="min-[600px]:hidden" />
      {!(isService && hasLogo) && <BrandLogo height={40} className="hidden min-[600px]:flex" />}
    </>
  );
}

/** The square mark at the top of the rail, on a service screen with a logo. */
function RailMark({ isService }) {
  const { brand } = useTheme();
  const hasLogo = Boolean(brand.logos?.LIGHT_GROUND?.dataUrl || brand.logos?.DARK_GROUND?.dataUrl);
  if (!hasLogo || !isService) return null;
  return (
    <NavLink to="/dashboard" className="mb-2 flex min-h-12 items-center justify-center rounded-[10px]">
      <BrandLogo shape="mark" height={44} />
    </NavLink>
  );
}

/**
 * P32. What a screen in a lazy chunk shows while the chunk arrives: the
 * screen's shape, still, inside the frame, which stays where it is. Never
 * `null`, which would look like a broken screen (DESIGN-SYSTEM section 13c).
 */
export function ScreenLoading() {
  return (
    <div className="p-4">
      <Spinner size="lg" label="Opening the screen" />
    </div>
  );
}

export default function AppShell({ children }) {
  const { user, features } = useAuth();
  const { pathname } = useLocation();
  const places = useMainPlaces();
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => setMoreOpen(false), [pathname]);

  /**
   * P42. The kitchen login: the ticket board and a bar with who is signed in
   * and Sign out. No rail, no bottom bar, no More: nothing but the tickets.
   */
  if (user?.role === 'KITCHEN') {
    return (
      <div className="v2 flex h-full flex-col bg-ground text-ink">
        <header className="flex min-h-12 flex-none items-center justify-between gap-3 border-b border-line bg-surface px-4 print:hidden">
          <TopBarMark isService />
          <span className="flex items-center gap-3">
            {/* P62. This device's connection to the cafe server, on every device. */}
            <ConnectionStatus />
            <AccountMenu />
          </span>
        </header>
        <LostConnectionBanner />
        <LiveConnection />
        <div className="relative min-h-0 flex-1 overflow-y-auto print:overflow-visible">
          <Suspense fallback={<ScreenLoading />}>{children}</Suspense>
        </div>
      </div>
    );
  }

  if (FULL_SCREEN_PATHS.includes(pathname)) {
    return (
      <>
        <LostConnectionBanner />
        <LiveConnection />
        <Suspense fallback={<ScreenLoading />}>{children}</Suspense>
      </>
    );
  }

  return (
    <div className="v2 flex h-full bg-ground text-ink">
      <nav aria-label="Main" className="hidden w-[76px] flex-none flex-col items-center gap-1 overflow-y-auto border-r border-line bg-surface py-3 min-[600px]:flex print:!hidden">
        <RailMark isService={isServicePath(pathname)} />
        {places.map((place) => (
          <PlaceLink key={place.to} place={place} layout="rail" />
        ))}
        <MoreButton layout="rail" onClick={() => setMoreOpen(true)} />
        <NavLink to="/device" className="mt-auto flex min-h-12 w-16 items-center justify-center rounded-lg text-muted hover:bg-sunken hover:text-ink" aria-label="This device">
          <DeviceIcon />
        </NavLink>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 flex-none items-center justify-between gap-3 border-b border-line bg-surface px-4 print:hidden">
          <TopBarMark isService={isServicePath(pathname)} />
          <span className="flex items-center gap-3">
            {/* P62. This device's connection to the cafe server, and the cloud copy's state. */}
            <ConnectionStatus />
            {/* P63. Sync conflicts waiting for an owner or manager. */}
            <SyncBadge />
            {/* P48. Recall Bill, as on PetPooja: the till finds a bill by its number. */}
            {['OWNER', 'MANAGER', 'CASHIER'].includes(user?.role) && <BillNoSearch />}
            <AccountMenu />
          </span>
        </header>

        <LostConnectionBanner />
        <LiveConnection />
        <OnlineAlerts />
        {/* 2026-10-22. On the cafe PC the till prints captains' bills on the paper with no gap above. */}
        <CaptainBillPrinter paper={features?.sync?.server === 'BOX' ? CAFE_PC_PAPER : null} />
        <CounterKotPrinter />

        {/* `relative`, so anything absolutely placed inside a screen (screen-reader text,
            tooltips) belongs to this scroll area. Without it such an element was
            placed against the window and gave the page a second scroll. */}
        <div className="relative min-h-0 flex-1 overflow-y-auto print:overflow-visible">
          <Suspense fallback={<ScreenLoading />}>{children}</Suspense>
        </div>

        <nav aria-label="Main" className="flex flex-none items-stretch gap-1 border-t border-line bg-surface px-2 py-1 min-[600px]:hidden print:hidden">
          {places.map((place) => (
            <PlaceLink key={place.to} place={place} layout="bar" />
          ))}
          <MoreButton layout="bar" onClick={() => setMoreOpen(true)} />
        </nav>
      </div>

      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </div>
  );
}
