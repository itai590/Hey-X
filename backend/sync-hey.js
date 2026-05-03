const db = require('./db');
const { PRESENCE_ROW_ID } = require('./constants');

function syncHey() {
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO presence (id, last_update)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET last_update = excluded.last_update
  `);

  try {
    stmt.run(PRESENCE_ROW_ID, now);
    console.log('Presence updated successfully!');
  } catch (err) {
    console.error("Presence update error", err);
  }
}

module.exports = syncHey;
