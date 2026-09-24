const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(process.cwd(), 'data', 'trades.db');
const jsonPath = path.join(process.cwd(), 'logs', 'trades.json');
const historyPath = path.join(process.cwd(), 'logs', 'trades_history.json');

const db = new Database(dbPath);
const rows = db.prepare('SELECT id, raw_onchain_data, action, side, symbol FROM trades').all();

console.log('Fixing action and side for trades based on on-chain execution...');

const actionMap = new Map();

for (const r of rows) {
  let act = '';
  try {
    if (r.raw_onchain_data) {
      const parsed = JSON.parse(r.raw_onchain_data);
      act = String(parsed.action || '').toLowerCase();
    }
  } catch {}

  let newAction = r.action;
  let newSide = r.side;

  if (act.includes('short')) {
    newAction = 'SHORT';
    newSide = act.includes('open') ? 'sell' : 'buy';
  } else if (act.includes('long')) {
    newAction = 'LONG';
    newSide = act.includes('close') ? 'sell' : 'buy';
  }

  db.prepare('UPDATE trades SET action = ?, side = ? WHERE id = ?').run(newAction, newSide, r.id);
  actionMap.set(r.id, { action: newAction, side: newSide });
  console.log(`Trade ${r.id} (${r.symbol}): on-chain action="${act}" -> Action: ${newAction}, Side: ${newSide}`);
}

function updateJson(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (actionMap.has(t.id)) {
        const m = actionMap.get(t.id);
        t.action = m.action;
        t.side = m.side;
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
    console.log('Updated JSON journal:', filePath);
  } catch (e) {
    console.error('Failed to update JSON:', filePath, e.message);
  }
}

updateJson(jsonPath);
updateJson(historyPath);

const summary = db.prepare('SELECT action, count(*) as count FROM trades GROUP BY action').all();
console.log('Final Action Distribution in SQLite:');
console.table(summary);
