import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { ScreenLoading } from './components/AppShell.jsx';
import NotFoundPage from './components/NotFoundPage.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RequireFeature from './components/RequireFeature.jsx';
import RequireRole from './components/RequireRole.jsx';
import LoginPage from './features/auth/LoginPage.jsx';
import BillScreenPage from './features/billing/BillScreenPage.jsx';
import DashboardPage from './features/dashboard/DashboardPage.jsx';
import OwnerDashboardPage from './features/owner/OwnerDashboardPage.jsx';
import { useAuth } from './context/AuthContext.jsx';
import KitchenDisplayPage from './features/kitchen/KitchenDisplayPage.jsx';
import FloorViewPage from './features/orders/FloorViewPage.jsx';
import OrderScreenPage from './features/orders/OrderScreenPage.jsx';
import TakeawayOrderPage from './features/orders/TakeawayOrderPage.jsx';
import CounterSalePage from './features/orders/CounterSalePage.jsx';
import RequireOnline from './features/online/RequireOnline.jsx';
import { ROLES } from './features/users/roles.js';

/**
 * P32. Screens away from service load on first use, one chunk per group (`src/routes/`).
 * The service screens above stay in the main chunk: a captain or a cashier never waits for
 * one mid-rush. AppShell's Suspense draws the screen's still shape while a chunk arrives.
 */
const lazyScreen = (load, name) => lazy(() => load().then((group) => ({ default: group[name] })));
const reportsGroup = () => import('./routes/reports.js');
const settlementGroup = () => import('./routes/settlement.js');
const settingsGroup = () => import('./routes/settings.js');
const integrationsGroup = () => import('./routes/integrations.js');
const menuGroup = () => import('./routes/menu.js');
const inventoryGroup = () => import('./routes/inventory.js');
const attendanceGroup = () => import('./routes/attendance.js');
const peopleGroup = () => import('./routes/people.js');
const onlineGroup = () => import('./routes/online.js');
const deliveryGroup = () => import('./routes/delivery.js');
const ActivityLogPage = lazyScreen(reportsGroup, 'ActivityLogPage');
const LabourReportPage = lazyScreen(reportsGroup, 'LabourReportPage');
const ReportPage = lazyScreen(reportsGroup, 'ReportPage');
const ReportsIndexPage = lazyScreen(reportsGroup, 'ReportsIndexPage');
const StockReportPage = lazyScreen(reportsGroup, 'StockReportPage');
const BillDetailPage = lazyScreen(reportsGroup, 'BillDetailPage');
const BillListPage = lazyScreen(reportsGroup, 'BillListPage');
const BillsListPage = lazyScreen(settlementGroup, 'BillsListPage');
const ReceiptPreviewPage = lazyScreen(settlementGroup, 'ReceiptPreviewPage');
const AccountsPage = lazyScreen(settlementGroup, 'AccountsPage');
const CashBookPage = lazyScreen(settlementGroup, 'CashBookPage');
const DayClosePage = lazyScreen(settlementGroup, 'DayClosePage');
const DayEndPage = lazyScreen(settlementGroup, 'DayEndPage');
const PayoutsPage = lazyScreen(settlementGroup, 'PayoutsPage');
const TableArrangePage = lazyScreen(settingsGroup, 'TableArrangePage');
const TableManagementPage = lazyScreen(settingsGroup, 'TableManagementPage');
const DeviceSettingsPage = lazyScreen(settingsGroup, 'DeviceSettingsPage');
const AppearancePage = lazyScreen(settingsGroup, 'AppearancePage');
const SettingsPage = lazyScreen(settingsGroup, 'SettingsPage');
const StationsPage = lazyScreen(settingsGroup, 'StationsPage');
const IntegrationsPage = lazyScreen(integrationsGroup, 'IntegrationsPage');
const ItemMappingPage = lazyScreen(integrationsGroup, 'ItemMappingPage');
const TallyPage = lazyScreen(integrationsGroup, 'TallyPage');
const AvailabilityBoardPage = lazyScreen(menuGroup, 'AvailabilityBoardPage');
const MenuBuilderPage = lazyScreen(menuGroup, 'MenuBuilderPage');
const RecipeEditorPage = lazyScreen(inventoryGroup, 'RecipeEditorPage');
const StockListPage = lazyScreen(inventoryGroup, 'StockListPage');
const AttendanceRegisterPage = lazyScreen(attendanceGroup, 'AttendanceRegisterPage');
const ClockScreen = lazyScreen(attendanceGroup, 'ClockScreen');
const MyAttendancePage = lazyScreen(attendanceGroup, 'MyAttendancePage');
const CustomersPage = lazyScreen(peopleGroup, 'CustomersPage');
const StaffFormPage = lazyScreen(peopleGroup, 'StaffFormPage');
const StaffListPage = lazyScreen(peopleGroup, 'StaffListPage');
const BookingsPage = lazyScreen(onlineGroup, 'BookingsPage');
const ChatsPage = lazyScreen(onlineGroup, 'ChatsPage');
const OnlineInboxPage = lazyScreen(onlineGroup, 'OnlineInboxPage');
const DeliveryOrderPage = lazyScreen(deliveryGroup, 'DeliveryOrderPage');

/** Staff management is for the people who run the place. */
const STAFF_ADMIN_ROLES = [ROLES.OWNER, ROLES.MANAGER];

/**
 * So is editing the menu. The availability board is deliberately not gated:
 * all six roles may mark a dish out of stock, which is the one M1 write open
 * to the floor and the kitchen.
 */
const MENU_ADMIN_ROLES = [ROLES.OWNER, ROLES.MANAGER];

/**
 * Setting up the floor is back-office work, so it is gated like the menu.
 *
 * Taking orders is not: OWNER, MANAGER, CASHIER and WAITER all do it, and the
 * kitchen and storekeeper are kept out. The kitchen display itself is open to
 * everyone, because whoever is at the pass marks food ready.
 *
 * All of this is a convenience. The server refuses each endpoint to the wrong
 * role whether or not the screen is reachable.
 */
const TABLE_ADMIN_ROLES = [ROLES.OWNER, ROLES.MANAGER];
const ORDER_TAKING_ROLES = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER, ROLES.WAITER];

/**
 * M3. Creating a bill and taking payment is the till: OWNER, MANAGER, CASHIER.
 * Reading one bill and its receipt is open to all six on the server (a waiter
 * carries the bill to the table), so /bills/:billId is gated no narrower than
 * ProtectedRoute itself. Only the list, which is the till's own working
 * screen, is gated here.
 */
const BILLING_ROLES = [ROLES.OWNER, ROLES.MANAGER, ROLES.CASHIER];

/**
 * M4. Reading the stock list is open to all six on the server (a cook who
 * sees paneer is out marks the dish unavailable in M1), so /inventory itself
 * is gated no narrower than ProtectedRoute. The recipe editor is a writing
 * tool, gated the same way MenuBuilderPage is: OWNER and MANAGER, even though
 * a STOREKEEPER may read the underlying endpoint.
 */
const RECIPE_EDITOR_ROLES = [ROLES.OWNER, ROLES.MANAGER];

/**
 * M6. Reports are back-office reads for the two roles who run the place.
 * Two exceptions match the server exactly: the stock report also allows a
 * STOREKEEPER, whose job that read is, and the payment-method breakdown is
 * OWNER only, because the cash figure is the one a dishonest manager most
 * wants to control.
 */
const REPORT_ROLES = [ROLES.OWNER, ROLES.MANAGER];
const STOCK_REPORT_ROLES = [ROLES.OWNER, ROLES.MANAGER, ROLES.STOREKEEPER];

/**
 * M7. Settings are OWNER only here, even though a MANAGER may READ them on the
 * server. There is one settings screen and it is a form, so showing a manager a
 * page whose every control 403s on save would be worse than not showing it.
 * A manager who needs to know what the restaurant is set to can be told; the
 * read endpoint is open to them for exactly that.
 */
const SETTINGS_ROLES = [ROLES.OWNER];

/**
 * P23. The guest's page, in its own chunk. Since P32 the back-office screens
 * are in chunks of their own too, so a guest no longer downloads them.
 */
const PublicSite = lazy(() => import('./features/public/PublicSite.jsx'));

/**
 * Routes.
 *
 * One entry per screen. As modules land they add their own routes here and
 * their screens live under /features.
 */
/** P55. Signing in, or opening the address alone: the owner's dashboard for the owner, the ERP's home for everyone else. */
function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'OWNER' ? '/owner' : '/dashboard'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ProtectedRoute bare><HomeRedirect /></ProtectedRoute>} />
      {/* P55. The owner's dashboard, its own page outside the ERP's frame. */}
      <Route
        path="/owner"
        element={
          <ProtectedRoute bare>
            <RequireRole roles={['OWNER']}>
              <OwnerDashboardPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/staff"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <StaffListPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/staff/new"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <StaffFormPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/staff/:userId/edit"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <StaffFormPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/menu"
        element={
          <ProtectedRoute>
            <RequireRole roles={MENU_ADMIN_ROLES}>
              <MenuBuilderPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/menu/availability"
        element={
          <ProtectedRoute>
            <AvailabilityBoardPage />
          </ProtectedRoute>
        }
      />

      {/* M5. The clock is open to every role: a shared tablet on the wall. */}
      <Route
        path="/attendance"
        element={
          <ProtectedRoute>
            <RequireFeature feature="attendance">
              <ClockScreen />
            </RequireFeature>
          </ProtectedRoute>
        }
      />

      <Route
        path="/attendance/me"
        element={
          <ProtectedRoute>
            <RequireFeature feature="attendance">
              <MyAttendancePage />
            </RequireFeature>
          </ProtectedRoute>
        }
      />

      <Route
        path="/attendance/register"
        element={
          <ProtectedRoute>
            <RequireFeature feature="attendance">
              <RequireRole roles={STAFF_ADMIN_ROLES}>
                <AttendanceRegisterPage />
              </RequireRole>
            </RequireFeature>
          </ProtectedRoute>
        }
      />

      <Route
        path="/floor"
        element={
          <ProtectedRoute>
            <RequireRole roles={ORDER_TAKING_ROLES}>
              <FloorViewPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/orders/takeaway"
        element={
          <ProtectedRoute>
            <RequireRole roles={ORDER_TAKING_ROLES}>
              <TakeawayOrderPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* Counter Sale: a takeaway ordered, billed and paid in one go. */}
      <Route
        path="/orders/counter"
        element={
          <ProtectedRoute>
            <RequireRole roles={BILLING_ROLES}>
              <CounterSalePage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P06. Zomato and Swiggy orders typed in at the counter. */}
      <Route
        path="/orders/delivery"
        element={
          <ProtectedRoute>
            <RequireRole roles={ORDER_TAKING_ROLES}>
              <DeliveryOrderPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/orders/:orderId"
        element={
          <ProtectedRoute>
            <RequireRole roles={ORDER_TAKING_ROLES}>
              <OrderScreenPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/tables"
        element={
          <ProtectedRoute>
            <RequireRole roles={TABLE_ADMIN_ROLES}>
              <TableManagementPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P19. The floor plan editor, for whoever manages tables. */}
      <Route
        path="/tables/arrange"
        element={
          <ProtectedRoute>
            <RequireRole roles={TABLE_ADMIN_ROLES}>
              <TableArrangePage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* Open to all six. Whoever is standing at the pass marks food ready. */}
      <Route
        path="/kitchen"
        element={
          <ProtectedRoute>
            <KitchenDisplayPage />
          </ProtectedRoute>
        }
      />

      {/* P09. On Hold accounts: the till records collections; the server gates the rest. */}
      <Route
        path="/accounts"
        element={
          <ProtectedRoute>
            <RequireRole roles={BILLING_ROLES}>
              <AccountsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P29 Part F. The cash book, for the till. It replaced P10's cash drawer, whose address opens it. */}
      <Route
        path="/cash-book"
        element={
          <ProtectedRoute>
            <RequireRole roles={BILLING_ROLES}>
              <CashBookPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />
      <Route path="/cash" element={<Navigate to="/cash-book" replace />} />

      {/* P44. Day End: the day in three steps, and the day-end message. */}
      <Route
        path="/day-end"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <DayEndPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P10. Day Close, for the owner and manager. */}
      <Route
        path="/day-close"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <DayClosePage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P09. Platform payouts, back-office money for the owner and manager. */}
      <Route
        path="/payouts"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <PayoutsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/bills"
        element={
          <ProtectedRoute>
            <RequireRole roles={BILLING_ROLES}>
              <BillsListPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* Reading one bill is open to all six on the server: a waiter carries
          it to the table. The screen itself hides discount/void/payment for
          the wrong role; the server refuses each regardless. */}
      <Route
        path="/bills/:billId"
        element={
          <ProtectedRoute>
            <BillScreenPage />
          </ProtectedRoute>
        }
      />

      {/* The receipt preview reads the same two endpoints as the bill, both open to all six. */}
      <Route
        path="/bills/:billId/receipt"
        element={
          <ProtectedRoute>
            <ReceiptPreviewPage />
          </ProtectedRoute>
        }
      />

      {/* Open to all six on the server: a cook who sees paneer is out marks
          the dish unavailable in M1. */}
      <Route
        path="/inventory"
        element={
          <ProtectedRoute>
            <RequireFeature feature="inventory">
              <StockListPage />
            </RequireFeature>
          </ProtectedRoute>
        }
      />

      <Route
        path="/inventory/recipes"
        element={
          <ProtectedRoute>
            <RequireFeature feature="inventory">
              <RequireRole roles={RECIPE_EDITOR_ROLES}>
                <RecipeEditorPage />
              </RequireRole>
            </RequireFeature>
          </ProtectedRoute>
        }
      />

      {/* M19, P14. The Bill List every drill down opens, and one bill in full. */}
      <Route
        path="/reports/bills"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <BillListPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />
      <Route
        path="/reports/bills/:billId"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <BillDetailPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* M6. Read-only, back office, desktop. */}
      {/* M19, P18. Every report through one screen; the index lists what this role may open. */}
      <Route
        path="/reports"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <ReportsIndexPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/reports/activity"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <ActivityLogPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      <Route
        path="/reports/:name"
        element={
          <ProtectedRoute>
            <RequireRole roles={REPORT_ROLES}>
              <ReportPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* The old M6 addresses, so links and bookmarks still land on the new screens. */}
      <Route path="/reports/sales" element={<Navigate to="/reports/sales-by-day" replace />} />
      <Route path="/reports/tax" element={<Navigate to="/reports/gst" replace />} />




      <Route
        path="/reports/stock"
        element={
          <ProtectedRoute>
            <RequireFeature feature="inventory">
              <RequireRole roles={STOCK_REPORT_ROLES}>
                <StockReportPage />
              </RequireRole>
            </RequireFeature>
          </ProtectedRoute>
        }
      />

      <Route
        path="/reports/labour"
        element={
          <ProtectedRoute>
            <RequireFeature feature="attendance">
              <RequireRole roles={REPORT_ROLES}>
                <LabourReportPage />
              </RequireRole>
            </RequireFeature>
          </ProtectedRoute>
        }
      />


      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <RequireRole roles={SETTINGS_ROLES}>
              <SettingsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P20B. The look, owner only; the server's settings rule enforces it. */}
      <Route
        path="/settings/appearance"
        element={
          <ProtectedRoute>
            <RequireRole roles={SETTINGS_ROLES}>
              <AppearancePage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P27. Customers: OWNER and MANAGER; the server enforces it. */}
      <Route
        path="/customers"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <CustomersPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P25 Part L. Integrations: OWNER and MANAGER read, the server lets only the owner change. */}
      <Route
        path="/settings/integrations"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <IntegrationsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/tally"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <TallyPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/integrations/:provider"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <IntegrationsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings/integrations/:provider/mapping"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <ItemMappingPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P05. Printer settings for this device. Every role. */}
      <Route
        path="/device"
        element={
          <ProtectedRoute>
            <DeviceSettingsPage />
          </ProtectedRoute>
        }
      />

      {/* P05. Kitchen stations. The server enforces OWNER and MANAGER. */}
      <Route
        path="/stations"
        element={
          <ProtectedRoute>
            <RequireRole roles={STAFF_ADMIN_ROLES}>
              <StationsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P23. Online takeaway and bookings, the staff side. */}
      <Route
        path="/online"
        element={
          <ProtectedRoute>
            <RequireOnline orPlatform>
              <RequireRole roles={ORDER_TAKING_ROLES}>
                <OnlineInboxPage />
              </RequireRole>
            </RequireOnline>
          </ProtectedRoute>
        }
      />
      <Route
        path="/online/bookings"
        element={
          <ProtectedRoute>
            <RequireOnline>
              <RequireRole roles={ORDER_TAKING_ROLES}>
                <BookingsPage />
              </RequireRole>
            </RequireOnline>
          </ProtectedRoute>
        }
      />

      {/* P51. WhatsApp chats, for the till. The server decides who may read them. */}
      <Route
        path="/online/chats"
        element={
          <ProtectedRoute>
            <RequireRole roles={BILLING_ROLES}>
              <ChatsPage />
            </RequireRole>
          </ProtectedRoute>
        }
      />

      {/* P23. The guest's page. No sign-in, no app frame. */}
      <Route
        path="/r/:slug/*"
        element={
          <Suspense fallback={<ScreenLoading />}>
            <PublicSite />
          </Suspense>
        }
      />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
