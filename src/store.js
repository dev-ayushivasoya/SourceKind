import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';

// Minimal JSON-file database: zero native dependencies, easy to inspect, fine for an MVP.
const COLLECTIONS = ['pledges', 'scans', 'allocations', 'cycles', 'maintainers', 'events', 'invoices', 'actions', 'sessions', 'plans'];
const file = () => path.join(cfg.dataDir, 'db.json');
let data = Object.fromEntries(COLLECTIONS.map(c => [c, {}]));
let timer = null;

export function load() {
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; } catch { /* fresh db */ }
}
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const tmp = file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file());
    } catch (err) { console.error('db write failed', err.message); }
  }, 50);
}
export const uid = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
export const db = {
  get: (c, id) => data[c]?.[id],
  set: (c, id, obj) => { data[c][id] = obj; persist(); return obj; },
  update: (c, id, patch) => { data[c][id] = { ...data[c][id], ...patch }; persist(); return data[c][id]; },
  del: (c, id) => { delete data[c][id]; persist(); },
  all: (c) => Object.values(data[c] || {}),
  find: (c, fn) => Object.values(data[c] || {}).find(fn),
  filter: (c, fn) => Object.values(data[c] || {}).filter(fn),
  flush: () => { clearTimeout(timer); fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(data, null, 2)); },
};
load();
