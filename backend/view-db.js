require('./console-timestamp').install();
const db = require('./db');

function printMessages() {
  console.log("=== Messages ===");
  const stmt = db.prepare(`SELECT * FROM messages`);
  const rows = stmt.all();
  rows.forEach(row => {
    console.log(`🗨️  ${row.id} => "${row.text}"`);
    console.log(`   created: ${row.create_time}`);
    console.log(`   updated: ${row.update_time}`);
  });
  if (rows.length === 0) console.log("No messages found.");
}

function printPresence() {
  console.log("\n=== Presence ===");
  const stmt = db.prepare(`SELECT * FROM presence`);
  const rows = stmt.all();
  rows.forEach(row => {
    console.log(`👤 ${row.id} => last seen at ${row.last_update}`);
  });
  if (rows.length === 0) console.log("No presence records found.");
}

printMessages();
printPresence();
