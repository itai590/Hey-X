const db = require('./db');
const EventEmitter = require('events');
const { randomUUID } = require('crypto');
let aggrTime = 60; // seconds — updated via setAggrTime()
const BARK_TEXT = "Woof!";

const emitter = new EventEmitter();

const context = {
  text: "",
  timer: null,
  id: null,
};

const logTime = (message) => {
  console.log(message);
};

const resetContext = () => {
  logTime('Timer ended — Resetting context');
  context.text = "";
  context.timer = null;
  context.id = null;
  emitter.emit('reset');
};

const startOrRestartTimer = () => {
  if (context.timer) {
    clearTimeout(context.timer);
    logTime('Timer restarted');
  } else {
    logTime('Timer started');
  }
  context.timer = setTimeout(resetContext, aggrTime * 1000);
};

const sendNotification = () => {
  if (context.id) {
    // Already aggregating: append new bark
    context.text += " " + BARK_TEXT;
    logTime('Appended bark');

    const updateStmt = db.prepare(`
      UPDATE messages
      SET text = ?, update_time = ?
      WHERE id = ?
    `);
    updateStmt.run(context.text, new Date().toISOString(), context.id);

  } else {
    // New aggregation window
    logTime('New bark aggregation started');
    context.text = BARK_TEXT;
    context.id = randomUUID();

    const insertStmt = db.prepare(`
      INSERT INTO messages (id, text, create_time, update_time)
      VALUES (?, ?, ?, ?)
    `);
    const nowISO = new Date().toISOString();
    insertStmt.run(context.id, context.text, nowISO, nowISO);
  }

  // Always start or restart the timer
  startOrRestartTimer();

  return Promise.resolve(); // async chain-friendly (to keep test-hey.js readable)
};

module.exports = {
  send: sendNotification,
  on: emitter.on.bind(emitter),
  setAggrTime(seconds) { aggrTime = seconds; },
};
