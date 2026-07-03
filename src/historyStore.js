const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'history.db');

function openDatabase() {
  return new sqlite3.Database(DB_PATH);
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

class HistoryStore {
  constructor() {
    this.db = openDatabase();
  }

  async init() {
    await run(this.db, 'PRAGMA journal_mode = WAL;');
    await run(this.db, 'PRAGMA synchronous = NORMAL;');

    await run(
      this.db,
      `CREATE TABLE IF NOT EXISTS measurements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        active_power_w REAL,
        feed_in_w REAL,
        relay_enabled INTEGER NOT NULL,
        heater_current_a REAL,
        heater_power_w REAL,
        heater_on INTEGER NOT NULL,
        source TEXT NOT NULL,
        error_message TEXT
      )`
    );

    await run(
      this.db,
      `CREATE TABLE IF NOT EXISTS relay_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        relay_enabled INTEGER NOT NULL,
        reason TEXT NOT NULL,
        active_power_w REAL,
        heater_current_a REAL,
        heater_power_w REAL,
        heater_on INTEGER NOT NULL
      )`
    );

    await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_measurements_ts ON measurements(ts)');
    await run(this.db, 'CREATE INDEX IF NOT EXISTS idx_events_ts ON relay_events(ts)');
  }

  async insertMeasurement(measurement) {
    const {
      ts,
      activePowerW,
      feedInW,
      relayEnabled,
      heaterCurrentA,
      heaterPowerW,
      heaterOn,
      source,
      errorMessage,
    } = measurement;

    await run(
      this.db,
      `INSERT INTO measurements (
        ts,
        active_power_w,
        feed_in_w,
        relay_enabled,
        heater_current_a,
        heater_power_w,
        heater_on,
        source,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ts,
        activePowerW,
        feedInW,
        relayEnabled ? 1 : 0,
        heaterCurrentA,
        heaterPowerW,
        heaterOn ? 1 : 0,
        source,
        errorMessage || null,
      ]
    );
  }

  async insertRelayEvent(event) {
    const {
      ts,
      relayEnabled,
      reason,
      activePowerW,
      heaterCurrentA,
      heaterPowerW,
      heaterOn,
    } = event;

    await run(
      this.db,
      `INSERT INTO relay_events (
        ts,
        relay_enabled,
        reason,
        active_power_w,
        heater_current_a,
        heater_power_w,
        heater_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        ts,
        relayEnabled ? 1 : 0,
        reason,
        activePowerW,
        heaterCurrentA,
        heaterPowerW,
        heaterOn ? 1 : 0,
      ]
    );
  }

  async getHistory(hours = 24, limit = 1440) {
    const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
    const safeLimit = Math.max(60, Math.min(5000, Number(limit) || 1440));

    const rows = await all(
      this.db,
      `SELECT
          ts,
          active_power_w AS activePowerW,
          feed_in_w AS feedInW,
          relay_enabled AS relayEnabled,
          heater_current_a AS heaterCurrentA,
          heater_power_w AS heaterPowerW,
          heater_on AS heaterOn,
          source,
          error_message AS errorMessage
        FROM measurements
        WHERE ts >= datetime('now', ?)
        ORDER BY ts ASC
        LIMIT ?`,
      [`-${safeHours} hours`, safeLimit]
    );

    return rows.map((row) => ({
      ...row,
      relayEnabled: Boolean(row.relayEnabled),
      heaterOn: Boolean(row.heaterOn),
    }));
  }

  async getRelayEvents(hours = 24, limit = 500) {
    const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
    const safeLimit = Math.max(10, Math.min(5000, Number(limit) || 500));

    const rows = await all(
      this.db,
      `SELECT
          ts,
          relay_enabled AS relayEnabled,
          reason,
          active_power_w AS activePowerW,
          heater_current_a AS heaterCurrentA,
          heater_power_w AS heaterPowerW,
          heater_on AS heaterOn
        FROM relay_events
        WHERE ts >= datetime('now', ?)
        ORDER BY ts DESC
        LIMIT ?`,
      [`-${safeHours} hours`, safeLimit]
    );

    return rows.map((row) => ({
      ...row,
      relayEnabled: Boolean(row.relayEnabled),
      heaterOn: Boolean(row.heaterOn),
    }));
  }

  async getLastMeasurement() {
    const row = await get(
      this.db,
      `SELECT
          ts,
          active_power_w AS activePowerW,
          feed_in_w AS feedInW,
          relay_enabled AS relayEnabled,
          heater_current_a AS heaterCurrentA,
          heater_power_w AS heaterPowerW,
          heater_on AS heaterOn,
          source,
          error_message AS errorMessage
       FROM measurements
       ORDER BY ts DESC
       LIMIT 1`
    );

    if (!row) {
      return null;
    }

    return {
      ...row,
      relayEnabled: Boolean(row.relayEnabled),
      heaterOn: Boolean(row.heaterOn),
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  HistoryStore,
};
