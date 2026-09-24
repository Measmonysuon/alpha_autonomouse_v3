const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'trades.db');
const db = new Database(dbPath);

const tradeMappings = [
  { fillId: '689355706956947570', openId: 'decibel-1789351428133-rqoy4' },
  { fillId: 'txn-7197463358', openId: 'decibel-1789344551494-tqhk3' },
  { fillId: 'txn-7193094225', openId: 'decibel-1789313364346-1o0om' },
  { fillId: 'txn-7193040429', openId: 'decibel-1789317950434-l0dns' },
  { fillId: 'txn-7193031870', openId: 'decibel-1789317872115-u7x46' },
  { fillId: 'txn-7191839388', openId: 'decibel-1789301575739-0gcb4' },
  { fillId: '689266470111796629', openId: 'decibel-1789264268655-dnnpr' },
  { fillId: '689221555522164619', openId: 'agent-sui-1789219102086' }
];

console.log('Running reconciliation on', dbPath);

for (const m of tradeMappings) {
  db.prepare(
    "UPDATE trades SET strategy_name = 'Turtle Soup & Liquidity Grab', strategy_tags = '[\"template_turtle_soup\"]', is_manual = 0 WHERE id = ?"
  ).run(m.fillId);

  // Delete the unconfirmed duplicate open stub so it doesn't inflate trade count
  db.prepare("DELETE FROM trades WHERE id = ?").run(m.openId);
}

const stats = db.prepare(
  "SELECT strategy_name, count(*) as count, round(sum(realized_pnl), 4) as pnl, sum(case when realized_pnl > 0 then 1 else 0 end) as wins, sum(case when realized_pnl < 0 then 1 else 0 end) as losses FROM trades GROUP BY strategy_name"
).all();

console.log('Reconciliation complete. Grouped performance:');
console.table(stats);
