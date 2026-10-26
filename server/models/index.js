/**
 * Every model, in one list.
 *
 * `services/indexService.js` reads this to build and check indexes, and the
 * production boot check in `server.js` refuses to start while any index a model
 * here declares is missing from the database. A model left off this list has
 * its indexes silently ignored by both, which is exactly the failure P01 exists
 * to prevent.
 *
 * Every new model file must be added here. `tests/indexes.test.js` reads the
 * models folder and fails if one is missing, so forgetting is a red suite, not
 * a production surprise.
 *
 * Alphabetical by model name.
 */
import { Account } from './Account.js';
import { AccountEntry } from './AccountEntry.js';
import { AttendanceEntry } from './AttendanceEntry.js';
import { AuditLog } from './AuditLog.js';
import { Bill } from './Bill.js';
import { Branch } from './Branch.js';
import { CaReportSend } from './CaReportSend.js';
import { CashMovement } from './CashMovement.js';
import { Category } from './Category.js';
import { ChangelogCounter } from './ChangelogCounter.js';
import { ChangelogEntry } from './ChangelogEntry.js';
import { Conversation } from './Conversation.js';
import { Counter } from './Counter.js';
import { Customer } from './Customer.js';
import { DayClosure } from './DayClosure.js';
import { Ingredient } from './Ingredient.js';
import { IntakeApplication } from './IntakeApplication.js';
import { IntakeItem } from './IntakeItem.js';
import { IntegrationConnection } from './IntegrationConnection.js';
import { IntegrationEvent } from './IntegrationEvent.js';
import { IntegrationJob } from './IntegrationJob.js';
import { Kot } from './Kot.js';
import { MenuItem } from './MenuItem.js';
import { MenuPhoto } from './MenuPhoto.js';
import { MessageTemplate } from './MessageTemplate.js';
import { OnlineOrder } from './OnlineOrder.js';
import { OnlinePayment } from './OnlinePayment.js';
import { Order } from './Order.js';
import { PaymentMethod } from './PaymentMethod.js';
import { PlatformItemMapping } from './PlatformItemMapping.js';
import { PlatformOrder } from './PlatformOrder.js';
import { PlatformPayout } from './PlatformPayout.js';
import { Recipe } from './Recipe.js';
import { RefreshToken } from './RefreshToken.js';
import { Refund } from './Refund.js';
import { ReplicaCursor } from './ReplicaCursor.js';
import { ReplicationQuarantine } from './ReplicationQuarantine.js';
import { ReplicationState } from './ReplicationState.js';
import { Reservation } from './Reservation.js';
import { Restaurant } from './Restaurant.js';
import { ServerStart } from './ServerStart.js';
import { BackupRun } from './BackupRun.js';
import { BackupState } from './BackupState.js';
import { Station } from './Station.js';
import { StockMovement } from './StockMovement.js';
import { SyncConflict } from './SyncConflict.js';
import { SyncDoc } from './SyncDoc.js';
import { Table } from './Table.js';
import { TallyBridge } from './TallyBridge.js';
import { TallyExport } from './TallyExport.js';
import { TerminalTransaction } from './TerminalTransaction.js';
import { User } from './User.js';

export const ALL_MODELS = Object.freeze([
  Account,
  AccountEntry,
  AttendanceEntry,
  AuditLog,
  BackupRun,
  BackupState,
  Bill,
  Branch,
  CaReportSend,
  CashMovement,
  Category,
  ChangelogCounter,
  ChangelogEntry,
  Conversation,
  Counter,
  Customer,
  DayClosure,
  Ingredient,
  IntakeApplication,
  IntakeItem,
  IntegrationConnection,
  IntegrationEvent,
  IntegrationJob,
  Kot,
  MenuItem,
  MenuPhoto,
  MessageTemplate,
  OnlineOrder,
  OnlinePayment,
  Order,
  PaymentMethod,
  PlatformItemMapping,
  PlatformOrder,
  PlatformPayout,
  Recipe,
  RefreshToken,
  Refund,
  ReplicaCursor,
  ReplicationQuarantine,
  ReplicationState,
  Reservation,
  Restaurant,
  ServerStart,
  Station,
  StockMovement,
  SyncConflict,
  SyncDoc,
  Table,
  TallyBridge,
  TallyExport,
  TerminalTransaction,
  User,
]);

/**
 * P30. Models that belong to the server, which every restaurant shares, not
 * to any one restaurant: no `restaurantId`, no tenant guard, no restaurant's
 * data. The purge tool and the seed wipe skip them, because no restaurant owns
 * their documents. `restaurants` itself is the other exception, handled on its
 * own as the tenant. A new model joins this list only for the same reason.
 * P54: the backups' runs and state join it: like a server start, a backup is
 * the server's, and holds no restaurant's data.
 * P62: replication's own state joins it for the same reason.
 */
export const SERVER_MODELS = Object.freeze([ServerStart, BackupRun, BackupState, ReplicationState]);
