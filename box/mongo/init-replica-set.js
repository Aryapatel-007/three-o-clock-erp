// P62. Run once by install-ubuntu.sh with mongosh, on the box, before any user exists
// (the localhost exception). Makes the single-node replica set and the four logins.
//
//   APP_PASSWORD      cafe_app      readWrite on restaurant-erp: the server
//   BACKUP_PASSWORD   cafe_backup   backup + restore: the hourly mongodump --oplog
//   COMPASS_PASSWORD  cafe_compass  read only: day-to-day Compass (docs/RUNBOOK.md section 3)
//   REPAIR_PASSWORD   cafe_repair   readWrite: deliberate repairs only, never saved in Compass
//   ADMIN_PASSWORD    cafe_admin    root: kept in the owner's password manager

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

try {
  rs.status();
  print('The replica set already exists.');
} catch {
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] });
  print('Replica set rs0 started.');
}

// Wait to be primary before creating users.
for (let i = 0; i < 60 && !db.hello().isWritablePrimary; i += 1) sleep(1000);

const admin = db.getSiblingDB('admin');
const ensure = (user, pwd, roles) => {
  if (admin.getUser(user)) {
    print(`${user} exists, left as it is.`);
    return;
  }
  admin.createUser({ user, pwd, roles });
  print(`${user} created.`);
};

ensure('cafe_admin', env('ADMIN_PASSWORD'), [{ role: 'root', db: 'admin' }]);
ensure('cafe_app', env('APP_PASSWORD'), [{ role: 'readWrite', db: 'restaurant-erp' }]);
ensure('cafe_backup', env('BACKUP_PASSWORD'), [{ role: 'backup', db: 'admin' }, { role: 'restore', db: 'admin' }]);
ensure('cafe_compass', env('COMPASS_PASSWORD'), [{ role: 'read', db: 'restaurant-erp' }]);
ensure('cafe_repair', env('REPAIR_PASSWORD'), [{ role: 'readWrite', db: 'restaurant-erp' }]);
