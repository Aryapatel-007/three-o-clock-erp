// Makes the settings the checks need on a GitHub machine: a .env from .env.example with a fresh
// random value for every placeholder secret, and server/.env.test from its example. Nothing
// real is in either, and both are git-ignored.
import { randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync('.env.example', 'utf8').split(/\r?\n/).map((line) => {
  const match = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (!match) return line;
  if (match[1] === 'MONGO_URI') return 'MONGO_URI=mongodb://127.0.0.1:27017/ci?replicaSet=rs0';
  return /replace_me/i.test(match[2]) ? `${match[1]}=${randomBytes(32).toString('hex')}` : line;
});
writeFileSync('.env', `${lines.join('\n')}\n`);
copyFileSync('server/.env.test.example', 'server/.env.test');
