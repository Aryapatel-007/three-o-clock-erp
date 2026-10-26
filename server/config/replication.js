/**
 * What lives where. P62 section 3, docs/REPLICATION.md section 2.
 *
 * Every Mongoose model is named here exactly once, by model name, with:
 *   sync    MIRROR      shipped to the cloud copy through the changelog
 *           LOCAL_ONLY  never leaves the machine that writes it
 *   owner   BOX         the cafe box writes it (every operational collection)
 *           CLOUD       the mirror writes it (intake and its own bookkeeping)
 *           EACH        each machine keeps its own (sessions, server records)
 *   reason  one line, why
 *
 * `tests/replicationClassification.test.js` loads the model registry and fails
 * if a model is missing here, or if this names a model that does not exist. A
 * new model cannot be quietly left out of the copy, or out of the backup.
 *
 * When multi-branch arrives (P62 section 14), restaurant-wide configuration
 * changes `owner` to CLOUD here and gains a downward config channel. Nothing
 * else in this file has to move for that.
 */
export const SYNC = Object.freeze({ MIRROR: 'MIRROR', LOCAL_ONLY: 'LOCAL_ONLY' });
export const OWNER = Object.freeze({ BOX: 'BOX', CLOUD: 'CLOUD', EACH: 'EACH' });

const mirror = (reason) => Object.freeze({ sync: SYNC.MIRROR, owner: OWNER.BOX, reason });
const local = (owner, reason) => Object.freeze({ sync: SYNC.LOCAL_ONLY, owner, reason });

export const REPLICATION = Object.freeze({
  Account: mirror('On Hold accounts: money owed to the cafe.'),
  AccountEntry: mirror('Every charge and settlement on an On Hold account.'),
  AttendanceEntry: mirror('Hours worked, with their corrections.'),
  AuditLog: mirror('Who did what with money or trust. A restore without it loses the audit trail.'),
  BackupRun: local(OWNER.EACH, "P54's record of its own runs: the server's, not a restaurant's."),
  BackupState: local(OWNER.EACH, "P54's own resume point; shipping it would restore another machine's place."),
  Bill: mirror('Bills, with their GST invoice numbers.'),
  Branch: mirror('The outlet, its online page slug and settings.'),
  CaReportSend: mirror('P65. Which months went to the CA; a promoted copy must not send them again.'),
  CashMovement: mirror('The cash book.'),
  Category: mirror('Menu sections.'),
  ChangelogCounter: local(OWNER.BOX, "The changelog's own sequence. The mirror tracks what it applied in replicacursors."),
  ChangelogEntry: local(OWNER.BOX, 'The changelog itself: it is how state ships, so it is not state that ships.'),
  Conversation: mirror('WhatsApp conversations (P37, P51).'),
  Counter: mirror('Order, KOT and bill sequences. A promoted mirror must continue them, never restart them.'),
  Customer: mirror('Guest records and their consent.'),
  DayClosure: mirror('Day Close, with its blind count.'),
  Ingredient: mirror('Stock items.'),
  IntakeApplication: mirror("The box's outcome for each intake item; it travels up like any other state (P62 section 5.2)."),
  IntakeItem: local(OWNER.CLOUD, "Lives only on the mirror: the internet's requests, waiting for the box. The box never stores it."),
  IntegrationConnection: mirror('Partner connections. Credentials are sealed under INTEGRATION_SECRETS_KEY, never readable in the copy.'),
  IntegrationEvent: mirror('The partner event log.'),
  IntegrationJob: mirror('Outbound jobs, so a promoted mirror finds the refunds and acknowledgements still owed.'),
  Kot: mirror('Kitchen tickets.'),
  MenuItem: mirror('Dishes, prices and tax rates.'),
  MenuPhoto: mirror('Dish photos. The public page on the mirror shows them.'),
  MessageTemplate: mirror('WhatsApp templates and their approval state.'),
  OnlineOrder: mirror("Online takeaway requests. The mirror's public page reads their status."),
  OnlinePayment: mirror('Razorpay advances.'),
  Order: mirror('Orders.'),
  PaymentMethod: mirror('Payment methods.'),
  PlatformItemMapping: mirror("Swiggy and Zomato dish mappings."),
  PlatformOrder: mirror('Platform orders.'),
  PlatformPayout: mirror('Platform payouts.'),
  Recipe: mirror('Recipes for stock deduction.'),
  RefreshToken: local(OWNER.EACH, 'Sessions. After a promotion everyone signs in again (docs/RUNBOOK.md section 6).'),
  Refund: mirror('Refunds, sent and owed.'),
  ReplicaCursor: local(OWNER.CLOUD, "The mirror's own record of what it applied."),
  ReplicationQuarantine: local(OWNER.CLOUD, 'Batches the mirror refused for a stale epoch, kept for a person to read.'),
  ReplicationState: local(OWNER.EACH, "Each machine's epoch, resume token and shipper position."),
  SyncConflict: mirror('P63. Changes both sides made before they could tell each other: both sides list them.'),
  SyncDoc: local(OWNER.EACH, "P63. Each side's own record of the version both last agreed on; it describes this machine's copy, not the cafe's data."),
  Reservation: mirror('Table bookings.'),
  // Logo bytes are `select: false` so the ordering screen never carries them,
  // not because they are secret. They ship: the public page and the owner's
  // dashboard on the mirror draw the logo, and a restore without it is not whole.
  Restaurant: mirror('The tenant, its settings and its brand, logo bytes included (docs/REPLICATION.md section 2.2).'),
  ServerStart: local(OWNER.EACH, "Each server's own starts (P30)."),
  Station: mirror('Kitchen stations.'),
  StockMovement: mirror('Every stock movement, by its eventKey.'),
  Table: mirror('Tables and the floor plan.'),
  TallyBridge: mirror('The Tally bridge pairing.'),
  TallyExport: mirror('Tally exports.'),
  TerminalTransaction: mirror('Pine Labs card machine transactions.'),
  // Password and PIN hashes included: a restore that loses every login is not a restore.
  User: mirror('Staff and their logins, password and PIN hashes included.'),
});

/** The model names whose collections ship. */
export const MIRROR_MODEL_NAMES = Object.freeze(
  Object.entries(REPLICATION)
    .filter(([, entry]) => entry.sync === SYNC.MIRROR)
    .map(([name]) => name),
);
