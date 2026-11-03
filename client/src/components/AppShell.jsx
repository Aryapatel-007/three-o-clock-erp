import { Suspense, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext.jsx';
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
  ClockIcon,
  CrossIcon,
  DeviceIcon,
  EyeIcon,
  FloorIcon,
  GearIcon,
  GlobeIcon,
  HomeIcon,
  KitchenIcon,
  LockIcon,
  MenuBookIcon,
  MenuIcon,
  PeopleIcon,
  PersonIcon,
  PhoneIcon,
  PrintIcon,
  ReceiptIcon,
  ScooterIcon,
  TickIcon,
} from './ui/icons/index.jsx';
import AccountMenu, { SignOutButton } from './AccountMenu.jsx';
import LiveConnection from './LiveConnection.jsx';
import ConnectionStatus, { LostConnectionBanner } from '../features/network/ConnectionStatus.jsx';
import SyncBadge from '../features/sync/SyncBadge.jsx';
import Spinner from './ui/Spinner.jsx';

/**
 * The frame around every signed-in screen. DESIGN-SYSTEM sections 8a and 9.
 *
 * 2026-11-03: a top bar carries the role's main places as tabs, and the menu button
 * at its left opens a sidebar with every place, grouped, the way an AI chat app opens
 * its side panel. On a wide screen the sidebar sits beside the page and stays open
 * until closed (remembered on the device); narrower, it slides over the page. Under
 * 600px the main places sit in a bottom bar instead, where a thumb reaches them.
 *
 * Links are conveniences, not permissions. The server refuses each endpoint to
 * the wrong role whether or not a link is drawn, and a switched-off feature is
 * hidden here the same way.
 */
const FULL_SCREEN_PATHS = ['/attendance'];
const SIDEBAR_KEY = 'threeoclock.sidebar';

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

/** Each role's main places, in the order they are used. Five at most, so a phone's bottom bar never crowds. */
const MAIN_BY_ROLE = {
  OWNER: ['home', 'floor', 'kitchen', 'bills', 'reports'],
  MANAGER: ['home', 'floor', 'kitchen', 'bills', 'dayClose'],
  CASHIER: ['home', 'floor', 'bills', 'cash'],
  WAITER: ['home', 'floor', 'takeaway', 'kitchen'],
  KITCHEN: ['kitchen', 'availability'],
  STOREKEEPER: ['home', 'stock', 'availability'],
};

/**
 * Every place, grouped by what a person came to do. Each place appears once; setting
 * the restaurant up is apart from setting a device up; a page that only means
 * something on the restaurant PC (Network) is not offered on the website.
 */
function useSidebarGroups() {
  const { user, features } = useAuth();
  const role = user?.role;
  const owner = role === 'OWNER';
  const manager = owner || role === 'MANAGER';
  const till = manager || role === 'CASHIER';
  const floor = till || role === 'WAITER';
  const inventoryOn = features.inventory !== false;
  const attendanceOn = features.attendance !== false;
  const onlineOn = Boolean(features.online?.enabled);
  const onRestaurantPc = features?.sync?.server === 'BOX';

  const groups = [
    {
      title: 'Service',
      items: [
        { to: '/owner', label: 'Dashboard', Icon: ChartIcon, show: owner },
        { to: '/dashboard', label: 'Home', Icon: HomeIcon, show: true },
        { to: '/floor', label: 'Floor', Icon: FloorIcon, show: floor },
        { to: '/orders/takeaway', label: 'Takeaway', Icon: BagIcon, show: floor },
        { to: '/orders/delivery', label: 'Delivery', Icon: ScooterIcon, show: floor },
        { to: '/kitchen', label: 'Kitchen', Icon: KitchenIcon, show: true },
        { to: '/bills', label: 'Bills', Icon: ReceiptIcon, show: till },
        { to: '/menu/availability', label: 'Availability', Icon: TickIcon, show: true },
        { to: '/online', label: 'Online orders', Icon: GlobeIcon, show: floor && inboxOn(features) },
        { to: '/online/bookings', label: 'Bookings', Icon: ClockIcon, show: floor && onlineOn },
        // P51. WhatsApp chats, for the till.
        { to: '/online/chats', label: 'Chats', Icon: PhoneIcon, show: till && Boolean(features.online?.chats) },
      ],
    },
    {
      title: 'Money and reports',
      items: [
        { to: '/reports', label: 'Reports', Icon: ChartIcon, show: manager },
        { to: '/cash-book', label: 'Cash book', Icon: CashIcon, show: till },
        // P61. The cashier closes the day too.
        { to: '/day-end', label: 'Day End', Icon: LockIcon, show: till },
        { to: '/day-close', label: 'Day Close history', Icon: ClockIcon, show: manager },
        { to: '/accounts', label: 'On Hold', Icon: PersonIcon, show: till },
        { to: '/payouts', label: 'Payouts', Icon: CashIcon, show: manager },
        { to: '/customers', label: 'Customers', Icon: PeopleIcon, show: manager },
      ],
    },
    {
      title: 'Menu and staff',
      items: [
        { to: '/menu', label: 'Menu', Icon: MenuBookIcon, show: manager },
        { to: '/inventory', label: 'Stock', Icon: BagIcon, show: inventoryOn },
        { to: '/staff', label: 'Staff', Icon: PeopleIcon, show: manager },
        { to: '/attendance/register', label: 'Attendance', Icon: ClockIcon, show: attendanceOn && manager },
        { to: '/attendance/me', label: 'My hours', Icon: ClockIcon, show: attendanceOn },
      ],
    },
    {
      title: 'Restaurant',
      items: [
        { to: '/settings/restaurant', label: 'Restaurant details', Icon: HomeIcon, show: owner },
        { to: '/settings/invoice-layout', label: 'Invoice layout', Icon: ReceiptIcon, show: owner },
        { to: '/settings/ca-reports', label: 'CA reports', Icon: ChartIcon, show: owner },
        { to: '/settings/appearance', label: 'Appearance', Icon: EyeIcon, show: owner },
        { to: '/tables', label: 'Table setup', Icon: FloorIcon, show: manager },
        { to: '/stations', label: 'Stations', Icon: KitchenIcon, show: manager },
        { to: '/settings/integrations', label: 'Integrations', Icon: GlobeIcon, show: manager },
        { to: '/settings', label: 'Settings', Icon: GearIcon, show: owner },
      ],
    },
    {
      title: 'Devices',
      items: [
        { to: '/printers', label: 'Printers', Icon: PrintIcon, show: role !== 'KITCHEN' },
        { to: '/connect', label: 'Connect a device', Icon: DeviceIcon, show: true },
        { to: '/device', label: 'This device', Icon: DeviceIcon, show: true },
        // P62. The restaurant PC's WiFi, the devices on it and the cloud copy.
        { to: '/network', label: 'Network and devices', Icon: GlobeIcon, show: manager && onRestaurantPc },
        // P63. Two-way sync with the website, and its conflicts.
        {
          to: '/sync',
          label: 'Push and pull',
          Icon: GlobeIcon,
          show: manager && (features?.sync?.mode === 'TWO_WAY' || ['BOX', 'MIRROR'].includes(features?.sync?.server)),
        },
      ],
    },
  ];
  return groups.map((group) => ({ ...group, items: group.items.filter((item) => item.show) })).filter((group) => group.items.length > 0);
}

/** The till's roles, who get Online beside their main places while it is on. */
const ONLINE_MAIN_ROLES = ['OWNER', 'MANAGER', 'CASHIER'];

function useMainPlaces() {
  const { user, features } = useAuth();
  const keys = [...(MAIN_BY_ROLE[user?.role] ?? ['home'])];
  // P25 Part H. Also while a delivery platform is connected: its orders arrive in the same inbox.
  if (inboxOn(features) && ONLINE_MAIN_ROLES.includes(user?.role)) keys.push('online');
  return keys.filter((key) => key !== 'stock' || features.inventory !== false).map((key) => PLACES[key]);
}

const isCurrent = (pathname, to) =>
  pathname === to ||
  (to !== '/dashboard' && pathname.startsWith(`${to}/`) && !(to === '/menu' && pathname.startsWith('/menu/availability'))) ||
  // An order opened from the floor belongs to the floor.
  (to === '/floor' && pathname.startsWith('/orders/') && !pathname.startsWith('/orders/takeaway') && !pathname.startsWith('/orders/delivery'));

/** The waiting count on the Online place, from the same query the alert polls. */
function OnlineBadge() {
  const alertsOn = useAlertsOn();
  const { data } = useOnlineInbox(alertsOn);
  const waiting = data ? data.waitingOrders + data.waitingReservations : 0;
  if (!waiting) return null;
  return (
    <span className="type-caption absolute -right-2 -top-1 flex min-w-5 items-center justify-center rounded-full bg-alert px-1 text-on-accent">{waiting}</span>
  );
}

/** A main place as a tab in the top bar: icon and word, the current one filled. */
function TopTab({ place }) {
  const { pathname } = useLocation();
  const active = isCurrent(pathname, place.to);
  const Icon = place.Icon;
  return (
    <NavLink
      to={place.to}
      aria-current={active ? 'page' : undefined}
      title={place.label}
      className={[
        'type-label flex h-10 flex-none items-center gap-2 rounded-lg px-3 transition-colors',
        active ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
      ].join(' ')}
    >
      <span className={`relative ${active ? 'text-accent' : ''}`}>
        <Icon size={18} />
        {place.to === '/online' && <OnlineBadge />}
      </span>
      <span className="hidden lg:inline">{place.label}</span>
    </NavLink>
  );
}

/** A main place in the phone's bottom bar. */
function BottomTab({ place }) {
  const { pathname } = useLocation();
  const active = isCurrent(pathname, place.to);
  const Icon = place.Icon;
  return (
    <NavLink
      to={place.to}
      aria-current={active ? 'page' : undefined}
      className={[
        'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-0.5 transition-colors',
        active ? 'bg-sunken text-ink' : 'text-muted hover:bg-sunken hover:text-ink',
      ].join(' ')}
    >
      <span className={`relative ${active ? 'text-accent' : ''}`}>
        <Icon size={22} />
        {place.to === '/online' && <OnlineBadge />}
      </span>
      <span className="type-caption text-center leading-tight tracking-tight">{place.label}</span>
    </NavLink>
  );
}

/** Every place, in groups, down the left. */
function Sidebar({ onClose, overlay }) {
  const groups = useSidebarGroups();
  return (
    <aside
      aria-label="All places"
      className={[
        'flex w-72 flex-none flex-col border-r border-line bg-surface print:hidden',
        overlay ? 'fixed inset-y-0 left-0 z-50 shadow-float' : 'h-full',
      ].join(' ')}
    >
      <nav aria-label="All places" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
        {groups.map((group, index) => (
          <div key={group.title} className={index > 0 ? 'mt-3 border-t border-line pt-3' : 'pt-3'}>
            {/* A heading, not a place: small capitals, no icon, never a hover. */}
            <p className="mb-1 px-3 text-[11px] font-semibold uppercase leading-6 tracking-[0.12em] text-muted">{group.title}</p>
            <ul className="flex flex-col">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={overlay ? onClose : undefined}
                    end={['/menu', '/bills', '/settings', '/online'].includes(item.to)}
                    className={({ isActive }) =>
                      [
                        'type-label flex min-h-11 items-center gap-3 rounded-lg px-3 transition-colors',
                        isActive ? 'bg-ink text-surface' : 'text-ink hover:bg-sunken',
                      ].join(' ')
                    }
                  >
                    {item.Icon && <item.Icon size={18} />}
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <SignOutButton />
      </div>
    </aside>
  );
}

function readSidebarOpen() {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === 'open';
  } catch {
    return false;
  }
}

function useWideScreen() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return undefined;
    const onChange = () => setWide(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return wide;
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
  const wide = useWideScreen();
  // Open beside the page on a wide screen, remembered; over the page otherwise, never remembered.
  const [pinned, setPinned] = useState(readSidebarOpen);
  const [sliding, setSliding] = useState(false);
  const sidebarOpen = wide ? pinned : sliding;

  useEffect(() => setSliding(false), [pathname]);
  const toggleSidebar = () => {
    if (!wide) {
      setSliding((now) => !now);
      return;
    }
    setPinned((now) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, now ? 'closed' : 'open');
      } catch {
        // Not remembered in a private window: only this visit keeps it.
      }
      return !now;
    });
  };
  const closeSidebar = () => (wide ? toggleSidebar() : setSliding(false));

  // The service screens (Home, Floor, an order, the bill, the kitchen) arrive while
  // the first screen draws, so tapping one never waits for its download.
  // Bills, the Cash book and Day End are the till's own main places, so its roles get them early too.
  const tillRole = ['OWNER', 'MANAGER', 'CASHIER'].includes(user?.role);
  useEffect(() => {
    import('../routes/service.js').catch(() => {});
    if (tillRole) import('../routes/settlement.js').catch(() => {});
  }, [tillRole]);

  /**
   * P42. The kitchen login: the ticket board and a bar with who is signed in
   * and Sign out. No tabs, no sidebar: nothing but the tickets.
   */
  if (user?.role === 'KITCHEN') {
    return (
      <div className="v2 flex h-full flex-col bg-ground text-ink">
        <header className="flex min-h-14 flex-none items-center justify-between gap-3 border-b border-line bg-surface px-4 print:hidden">
          <BrandLogo height={32} />
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
    <div className="v2 flex h-full flex-col bg-ground text-ink">
      {/* Three columns: the menu and logo, the main places centred, the status and account. */}
      <header className="grid min-h-14 flex-none grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-line bg-surface px-2 print:hidden sm:px-3">
        <span className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? 'Close the menu' : 'Open the menu'}
          aria-expanded={sidebarOpen}
          className="flex size-11 flex-none items-center justify-center rounded-lg text-ink hover:bg-sunken"
        >
          <MenuIcon size={22} />
        </button>
        <NavLink to="/dashboard" className="flex min-w-0 items-center">
          <BrandLogo height={32} />
        </NavLink>
        </span>

        {/* The main places as tabs, centred, from 600px; a phone has them in the bottom bar. */}
        <nav aria-label="Main" className="hidden min-w-0 items-center justify-center gap-1 overflow-x-auto rounded-xl bg-sunken p-1 min-[600px]:flex">
          {places.map((place) => (
            <TopTab key={place.to} place={place} />
          ))}
        </nav>
        <span className="min-[600px]:hidden" />

        <span className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
          {/* P62. This device's connection to the cafe server, and the cloud copy's state. */}
          <ConnectionStatus />
          {/* P63. Sync conflicts waiting for an owner or manager. */}
          <SyncBadge />
          <AccountMenu />
        </span>
      </header>

      <LostConnectionBanner />
      <LiveConnection />
      <OnlineAlerts />
      {/* 2026-10-22. On the cafe PC the till prints captains' bills on the paper with no gap above. */}
      <CaptainBillPrinter paper={features?.sync?.server === 'BOX' ? CAFE_PC_PAPER : null} />
      <CounterKotPrinter />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && wide && <Sidebar onClose={closeSidebar} overlay={false} />}
        {/* `relative`, so anything absolutely placed inside a screen belongs to this
            scroll area rather than to the window, which gave the page a second scroll. */}
        <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto print:overflow-visible">
          <Suspense fallback={<ScreenLoading />}>{children}</Suspense>
        </div>
      </div>

      <nav aria-label="Main" className="flex flex-none items-stretch gap-1 border-t border-line bg-surface px-2 py-1 min-[600px]:hidden print:hidden">
        {places.map((place) => (
          <BottomTab key={place.to} place={place} />
        ))}
      </nav>

      {sidebarOpen && !wide && (
        <>
          <button type="button" aria-label="Close the menu" onClick={closeSidebar} className="fixed inset-0 z-40 bg-ink/30 print:hidden" />
          <Sidebar onClose={closeSidebar} overlay />
        </>
      )}
    </div>
  );
}
