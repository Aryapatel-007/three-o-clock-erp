/**
 * The service group: home, the floor, an order, takeaway, the bill and the kitchen.
 * 2026-11-03. Out of the first download, so the sign-in screen opens fast on a slow
 * line; AppShell starts fetching this chunk the moment someone is signed in, so by the
 * time a person taps Floor it is already here and service screens still open at once.
 */
export { default as BillScreenPage } from '../features/billing/BillScreenPage.jsx';
export { default as DashboardPage } from '../features/dashboard/DashboardPage.jsx';
export { default as KitchenDisplayPage } from '../features/kitchen/KitchenDisplayPage.jsx';
export { default as FloorViewPage } from '../features/orders/FloorViewPage.jsx';
export { default as OrderScreenPage } from '../features/orders/OrderScreenPage.jsx';
export { default as TakeawayOrderPage } from '../features/orders/TakeawayOrderPage.jsx';
export { default as OwnerDashboardPage } from '../features/owner/OwnerDashboardPage.jsx';
