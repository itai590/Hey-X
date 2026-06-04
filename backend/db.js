const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const rawDbPath = process.env.HEY_DB_PATH || path.join(__dirname, 'data', 'hey.db');
const resolvedDbPath = rawDbPath === ':memory:' ? ':memory:' : path.resolve(rawDbPath);

// Ensure parent directory exists (skip for in-memory)
if (resolvedDbPath !== ':memory:') {
  const dataDir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`[INIT] 📂 Created missing data directory: ${dataDir}`);
  }
}

const db = new Database(resolvedDbPath);


// Create tables on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    text TEXT,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS presence (
    id TEXT PRIMARY KEY,
    last_update DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_login_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at TEXT NOT NULL,
    username TEXT,
    ip TEXT,
    xff_first TEXT
  );
`);

module.exports = db;