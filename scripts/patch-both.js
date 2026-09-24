const fs = require('fs');
const Database = require('better-sqlite3');

const jsonPath = '/app/logs/trades.json';
const historyPath = '/app/logs/trades_history.json';
const dbPath = '/app/data/trades.db';

const turtleFillIds = new Set([
  '689355706956947570',
  'txn-7197463358',
  'txn-7193094225',
  'txn-7193040429',
  'txn-7193031870',
  'txn-7191839388',
  '689266470111796629',
  '689221555522164619'
]);

const stubIds = new Set([
  'decibel-1789351428133-rqoy4',
  'decibel-1789344551494-tqhk3',
  'decibel-1789317950434-l0dns',
  'decibel-1789317872115-u7x46',
  'decibel-1789313364346-1o0om',
  'decibel-1789301575739-0gcb4',
  'decibel-1789264268655-dnnpr',
  'agent-sui-1789219102086'
]);

function patchJson(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    let list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(list)) return;
    list = list.filter(t => !stubIds.has(t.id));
    for (const t of list) {
      if (turtleFillIds.has(t.id)) {
        t.strategyName = 'Turtle Soup & Liquidity Grab';
        t.strategyTags = ['template_turtle_soup'];
        t.isManual = false;
        t.status = (t.pnlUsd && t.pnlUsd > 0) ? 'closed_tp' : 'closed_sl';
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf8');
    console.log('Patched JSON file:', filePath, 'Count:', list.length);
  } catch (err) {
    console.error('Error patching JSON:', filePath, err.message);
  }
}

patchJson(jsonPath);
patchJson(historyPath);

const db = new Database(dbPath);
for (const id of stubIds) {
  db.prepare('DELETE FROM trades WHERE id = ?').run(id);
}
for (const id of turtleFillIds) {
  db.prepare(`
    UPDATE trades 
    SET strategy_name = 'Turtle Soup & Liquidity Grab',
        strategy_tags = '["template_turtle_soup"]',
        is_manual = 0,
        status = CASE WHEN realized_pnl > 0 THEN 'closed_tp' ELSE 'closed_sl' END
    WHERE id = ?
  `).run(id);
}

const stats = db.prepare(`
  SELECT 
    strategy_name,
    count(*) as count,
    sum(case when status != 'OPEN' AND realized_pnl > 0 then 1 else 0 end) as wins,
    sum(case when status != 'OPEN' AND realized_pnl < 0 then 1 else 0 end) as losses,
    round(sum(realized_pnl), 4) as pnl
  FROM trades
  GROUP BY strategy_name
`).all();

console.log('SQLite stats after patch:');
console.table(stats);
