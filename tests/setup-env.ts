/**
 * Hermetic test environment.
 *
 * Jest runs this before any test module (and therefore before src/config and
 * src/db/database are imported), so the suite executes against a throwaway
 * settings file and a throwaway SQLite database in a temp directory.
 *
 * Before this existed, `npm test` read the LIVE deployment's settings.json
 * (failing on any machine whose real budget/leverage/model differed from the
 * author's) and INSERTED fixture trades into the live data/trades.db.
 * Tests must never touch production state.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-v3-test-'));

// Isolated settings fixture: the exact values the configuration test verifies.
const fixtureSettings = {
  trading: { budgetUsd: 200, maxLeverage: 13, paperTrading: true },
  ai: { model: 'gemini-4-argon' },
};
const settingsPath = path.join(tmpDir, 'settings.json');
fs.writeFileSync(settingsPath, JSON.stringify(fixtureSettings, null, 2), 'utf8');

process.env.ALPHA_SETTINGS_FILE = settingsPath;
process.env.TRADES_DB_PATH = path.join(tmpDir, 'trades.db');
