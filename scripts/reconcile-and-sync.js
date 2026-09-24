const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(process.cwd(), 'data', 'trades.db');
const journalPath = path.join(process.cwd(), 'logs', 'trades.json');

const db = new Database(dbPath);

const turtleFillIds = [
  '689355706956947570',
  'txn-7197463358',
  'txn-7193094225',
  'txn-7193040429',
  'txn-7193031870',
  'txn-7191839388',
  '689266470111796629',
  '689221555522164619'
];

const stubIds = [
  'decibel-1789351428133-rqoy4',
  'decibel-1789344551494-tqhk3',
  'decibel-1789317950434-l0dns',
  'decibel-1789317872115-u7x46',
  'decibel-1789313364346-1o0om',
  'decibel-1789301575739-0gcb4',
  'decibel-1789264268655-dnnpr',
  'agent-sui-1789219102086'
];

console.log('1. Updating Turtle Soup fills in SQLite...');
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

console.log('2. Removing unconfirmed stub trades...');
for (const id of stubIds) {
  db.prepare('DELETE FROM trades WHERE id = ?').run(id);
}

console.log('3. Grouped performance in SQLite:');
const perf = db.prepare(`
  SELECT 
    strategy_name,
    count(*) as total,
    sum(case when realized_pnl > 0 then 1 else 0 end) as wins,
    sum(case when realized_pnl < 0 then 1 else 0 end) as losses,
    round(sum(realized_pnl), 4) as net_pnl,
    round(avg(realized_pnl), 4) as avg_pnl
  FROM trades
  GROUP BY strategy_name
`).all();
console.table(perf);

console.log('4. Syncing SQLite rows to logs/trades.json for complete journal consistency...');
const allTrades = db.prepare('SELECT * FROM trades ORDER BY opened_at ASC').all();
const journalTrades = allTrades.map(dbT => {
  let strategyTags = [];
  try { if (dbT.strategy_tags) strategyTags = JSON.parse(dbT.strategy_tags); } catch {}
  return {
    id: dbT.id,
    symbol: dbT.symbol,
    side: dbT.side,
    action: dbT.action,
    entryPrice: dbT.entry_price,
    takeProfit: 0,
    stopLoss: 0,
    sizeBase: dbT.size,
    sizeUsd: (dbT.entry_price * dbT.size) || 0,
    leverage: dbT.leverage || 1,
    allocatedUsd: dbT.allocated_usd || 0,
    confidence: dbT.confidence || 80,
    openedAt: dbT.opened_at,
    closedAt: dbT.closed_at,
    exitPrice: dbT.exit_price,
    pnlUsd: dbT.realized_pnl,
    pnlPct: dbT.realized_pnl_pct,
    status: dbT.status,
    isManual: Boolean(dbT.is_manual),
    strategyName: dbT.strategy_name,
    strategyTags,
    entryRationale: dbT.entry_rationale,
    exitReason: dbT.exit_reason,
    postMortemLesson: dbT.post_mortem_lesson,
  };
});

fs.writeFileSync(journalPath, JSON.stringify(journalTrades, null, 2), 'utf8');
console.log('Successfully synced', journalTrades.length, 'trades to', journalPath);
