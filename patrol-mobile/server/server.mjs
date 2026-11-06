import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = resolve(process.env.PATROL_DATA_DIR || 'server/data');
const webDir = resolve(process.env.PATROL_WEB_DIR || 'dist');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(resolve(dataDir, 'patrol.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS points (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS patrols (id TEXT PRIMARY KEY, guard_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, guard_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'New');
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, interval INTEGER NOT NULL);
  INSERT OR IGNORE INTO settings VALUES (1, 60);
`);

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 128;
}
const emailOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const digest = token => createHash('sha256').update(token).digest('hex');
const dummyPassword = passwordHash('unused login sentinel');

if (process.argv.includes('--create-manager')) {
  const email = emailOf(process.env.PATROL_MANAGER_EMAIL);
  const password = process.env.PATROL_MANAGER_PASSWORD;
  if (!validEmail(email) || !validPassword(password)) {
    throw new Error('Set PATROL_MANAGER_EMAIL and PATROL_MANAGER_PASSWORD (12–128 characters).');
  }
  db.prepare("INSERT INTO users (id, name, email, password, role) VALUES (?, ?, ?, ?, 'manager')")
    .run(randomUUID(), process.env.PATROL_MANAGER_NAME?.trim() || 'Site manager', email, passwordHash(password));
  console.log('Manager account created.');
  process.exit(0);
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Expected JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64000) fail(413, 'Request too large.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected an object.');
  return value;
}
function field(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'Invalid or missing field.');
  return value.trim();
}
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(400, 'Invalid timestamp.');
  return new Date(value).toISOString();
}
function session(req) {
  const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) fail(401, 'Sign in to continue.');
  const hash = digest(token);
  const user = db.prepare(`SELECT users.id, users.name, users.role FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE hash = ? AND expires > ? AND active = 1`).get(hash, Date.now());
  if (!user) fail(401, 'Your session expired. Sign in again.');
  return { user, hash };
}
const points = () => db.prepare('SELECT id, name FROM points ORDER BY rowid').all();
const interval = () => db.prepare('SELECT interval FROM settings WHERE id = 1').get().interval;
function records(table, userId) {
  const where = userId ? 'WHERE records.guard_id = ?' : '';
  const query = db.prepare(`SELECT records.*, users.name AS guardName FROM ${table} AS records
    JOIN users ON users.id = records.guard_id ${where} ORDER BY records.rowid DESC`);
  return (userId ? query.all(userId) : query.all()).map(row => ({
    ...JSON.parse(row.payload), id: row.id, guardId: row.guard_id, guardName: row.guardName,
    ...(row.status ? { status: row.status } : {}),
  }));
}
function workspace(user) {
  const manager = user.role === 'manager';
  return {
    points: points(), interval: interval(),
    patrols: records('patrols', manager ? null : user.id),
    reports: records('reports', manager ? null : user.id),
    ...(manager ? { guards: db.prepare("SELECT id, name, email FROM users WHERE role = 'guard' AND active = 1 ORDER BY name").all() } : {}),
  };
}

const attempts = new Map();
export async function api(req, path) {
  if (req.method === 'POST' && path === '/api/sign-in') {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const address = req.socket.remoteAddress;
    const attempt = attempts.get(address) || { count: 0, until: now + 60_000 };
    if (attempt.count >= 12) fail(429, 'Too many attempts. Try again in a minute.');
    attempt.count++;
    attempts.set(address, attempt);
    const input = await body(req);
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(emailOf(input.email));
    const expected = user?.password || dummyPassword;
    const actual = passwordHash(typeof input.password === 'string' ? input.password.slice(0, 128) : '', expected.split(':')[0]);
    if (!user || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected)) || !validPassword(input.password)) {
      fail(401, 'Email or password is incorrect.');
    }
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, now + 12 * 3600000);
    return { token, user: { id: user.id, name: user.name, role: user.role } };
  }

  const { user, hash } = session(req);
  if (req.method === 'POST' && path === '/api/sign-out') {
    db.prepare('DELETE FROM sessions WHERE hash = ?').run(hash);
    return {};
  }
  if (req.method === 'GET' && path === '/api/workspace') return workspace(user);

  if (user.role === 'manager') {
    if (req.method !== 'POST') fail(404, 'Action not found.');
    const input = await body(req);
    session(req);
    switch (path) {
      case '/api/guards/add': {
        const email = emailOf(input.email);
        if (!validEmail(email) || !validPassword(input.password)) fail(400, 'Enter a valid email and a password of 12–128 characters.');
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'That email already has an account.');
        db.prepare("INSERT INTO users (id, name, email, password, role) VALUES (?, ?, ?, ?, 'guard')")
          .run(randomUUID(), field(input.name, 100), email, passwordHash(input.password));
        break;
      }
      case '/api/guards/remove':
        db.prepare("UPDATE users SET active = 0 WHERE id = ? AND role = 'guard'").run(field(input.id, 100));
        break;
      case '/api/points/add': {
        const name = field(input.name, 100);
        if (points().some(point => point.name.toLowerCase() === name.toLowerCase())) fail(409, 'That checkpoint already exists.');
        db.prepare('INSERT INTO points VALUES (?, ?)').run(randomUUID(), name);
        break;
      }
      case '/api/points/remove':
        db.prepare('DELETE FROM points WHERE id = ?').run(field(input.id, 100));
        break;
      case '/api/settings':
        if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 1440) fail(400, 'Enter 1 to 1440 minutes.');
        db.prepare('UPDATE settings SET interval = ? WHERE id = 1').run(input.interval);
        break;
      case '/api/reports/status':
        if (!['New', 'Acknowledged', 'Resolved'].includes(input.status)) fail(400, 'Invalid report status.');
        db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(input.status, field(input.id, 100));
        break;
      default: fail(404, 'Action not found.');
    }
    return workspace(user);
  }

  if (req.method === 'POST' && path === '/api/patrols') {
    const input = await body(req);
    session(req);
    const startedAt = timestamp(input.startedAt);
    const id = digest(user.id + ':' + startedAt);
    if (db.prepare('SELECT 1 FROM patrols WHERE id = ?').get(id)) return workspace(user);
    const finishedAt = timestamp(input.finishedAt);
    const current = points();
    if (!current.length || startedAt > finishedAt || !input.checked || typeof input.checked !== 'object'
      || !Array.isArray(input.points) || JSON.stringify(input.points) !== JSON.stringify(current.map(point => point.id))) {
      fail(409, 'Checkpoint setup changed. Refresh and start a new patrol.');
    }
    const checkpoints = current.map(point => {
      if (!Object.hasOwn(input.checked, point.id)) return { name: point.name };
      const scannedAt = timestamp(input.checked[point.id]);
      if (scannedAt < startedAt || scannedAt > finishedAt) fail(400, 'Checkpoint time is outside the patrol.');
      return { name: point.name, scannedAt };
    });
    const reason = checkpoints.some(point => !point.scannedAt) ? field(input.reason, 2000) : '';
    db.prepare('INSERT INTO patrols VALUES (?, ?, ?)').run(id, user.id, JSON.stringify({ startedAt, finishedAt, checkpoints, reason }));
    return workspace(user);
  }
  if (req.method === 'POST' && path === '/api/reports') {
    const input = await body(req);
    session(req);
    const id = digest(user.id + ':report:' + field(input.submissionId, 100));
    if (db.prepare('SELECT 1 FROM reports WHERE id = ?').get(id)) return workspace(user);
    const report = {
      category: field(input.category, 100), location: field(input.location, 200, false),
      description: field(input.description, 4000), createdAt: new Date().toISOString(),
    };
    db.prepare('INSERT INTO reports (id, guard_id, payload) VALUES (?, ?, ?)').run(id, user.id, JSON.stringify(report));
    return workspace(user);
  }
  fail(403, 'This action requires manager access.');
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };
if (import.meta.main) createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) return json(res, 200, await api(req, path));
    if (req.method !== 'GET') fail(405, 'Method not allowed.');
    const file = resolve(webDir, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(webDir + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) fail(404, 'Page not found.');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch (error) {
    if (!error.status) console.error(error);
    json(res, error.status || 500, { error: error.status ? error.message : 'Server error.' });
  }
}).listen(Number(process.env.PORT || 8787), '127.0.0.1', () => console.log('Patrol server listening on loopback.'));
