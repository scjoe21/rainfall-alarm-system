import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', '..', 'rainfall.db');

let db = null;

// Wrapper that provides a better-sqlite3-like synchronous API over sql.js
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  exec(sql) {
    this._db.run(sql);
    this._save();
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        self._db.run(sql, params);
        self._save();
      },
      get(...params) {
        const stmt = self._db.prepare(sql);
        if (params.length) stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const results = [];
        const stmt = self._db.prepare(sql);
        if (params.length) stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
    };
  }

  close() {
    this._save();
    this._db.close();
  }

  _save() {
    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(dbPath, buffer);
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }
}

export async function getDatabase() {
  if (db) return db;

  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DatabaseWrapper(sqlDb);
  return db;
}

export async function initDatabase() {
  const db = await getDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS metros (
      id INTEGER PRIMARY KEY,
      code VARCHAR(2) UNIQUE,
      name VARCHAR(50)
    );

    CREATE TABLE IF NOT EXISTS districts (
      id INTEGER PRIMARY KEY,
      metro_id INTEGER,
      code VARCHAR(5) UNIQUE,
      name VARCHAR(50),
      FOREIGN KEY (metro_id) REFERENCES metros(id)
    );

    CREATE TABLE IF NOT EXISTS emds (
      id INTEGER PRIMARY KEY,
      district_id INTEGER,
      code VARCHAR(10) UNIQUE,
      name VARCHAR(50),
      FOREIGN KEY (district_id) REFERENCES districts(id)
    );

    CREATE TABLE IF NOT EXISTS weather_stations (
      id INTEGER PRIMARY KEY,
      stn_id VARCHAR(10) UNIQUE,
      name VARCHAR(50),
      lat REAL,
      lon REAL,
      emd_id INTEGER,
      FOREIGN KEY (emd_id) REFERENCES emds(id)
    );

    CREATE TABLE IF NOT EXISTS rainfall_realtime (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER,
      timestamp DATETIME DEFAULT (datetime('now')),
      rainfall_15min REAL,
      FOREIGN KEY (station_id) REFERENCES weather_stations(id)
    );

    CREATE TABLE IF NOT EXISTS rainfall_forecast (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER,
      base_time DATETIME,
      forecast_time DATETIME,
      rainfall_forecast REAL,
      FOREIGN KEY (station_id) REFERENCES weather_stations(id)
    );

    CREATE TABLE IF NOT EXISTS alarm_settings (
      id INTEGER PRIMARY KEY,
      district_id INTEGER UNIQUE,
      realtime_threshold REAL DEFAULT 20.0,
      total_threshold REAL DEFAULT 55.0,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (district_id) REFERENCES districts(id)
    );

    CREATE TABLE IF NOT EXISTS alarm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emd_id INTEGER,
      station_id INTEGER,
      realtime_15min REAL,
      forecast_45min REAL,
      total_60min REAL,
      timestamp DATETIME DEFAULT (datetime('now')),
      FOREIGN KEY (emd_id) REFERENCES emds(id)
    );
  `);

  console.log('Database initialized');
  return db;
}

export default { getDatabase, initDatabase };
