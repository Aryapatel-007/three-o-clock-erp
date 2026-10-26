/**
 * P32. The settings group: settings, appearance, this device, stations and the tables.
 * App.jsx loads this module with import() the first time one of these screens
 * opens, so the group arrives as one chunk and only to the person who needs it.
 */
export { default as TableArrangePage } from '../features/orders/TableArrangePage.jsx';
export { default as TableManagementPage } from '../features/orders/TableManagementPage.jsx';
export { default as DeviceSettingsPage } from '../features/printing/DeviceSettingsPage.jsx';
export { default as PrintStationPage } from '../features/printing/PrintStationPage.jsx';
export { default as AppearancePage } from '../features/settings/AppearancePage.jsx';
export { default as InvoiceLayoutPage } from '../features/settings/InvoiceLayoutPage.jsx';
export { default as CaReportsPage } from '../features/settings/CaReportsPage.jsx';
export { default as SettingsPage } from '../features/settings/SettingsPage.jsx';
export { default as StationsPage } from '../features/stations/StationsPage.jsx';
export { default as NetworkPage } from '../features/network/NetworkPage.jsx';
export { default as SyncPage } from '../features/sync/SyncPage.jsx';
