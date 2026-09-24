/**
 * SQLite Database for On-Chain Trade History & AI Strategy Telemetry.
 * Uses better-sqlite3 with WAL mode for ultra-fast, concurrent atomic reads and writes.
 * Includes graceful in-memory fallback for environments with native ABI mismatches.
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface DbTrade {
  id: string;
  client_order_id?: string;
  tx_version?: string;
  market_address?: string;
  symbol: string;
  side: 'buy' | 'sell';
  action: 'LONG' | 'SHORT';
  is_manual: number; // 0 for AI, 1 for Manual
  entry_price: number;
  exit_price?: number;
  size: number;
  allocated_usd: number;
  leverage: number;
  realized_pnl?: number;
  realized_pnl_pct?: number;
  fee_usd?: number;
  status: string; // 'OPEN' | 'CLOSED_TP' | 'CLOSED_SL' | 'CLOSED_MANUAL' | 'CLOSED'
  opened_at: number;
  closed_at?: number;
  strategy_name?: string;
  strategy_tags?: string; // JSON array string
  confidence?: number;
  entry_rationale?: string;
  entry_snapshot?: string; // JSON string
  exit_reason?: string;
  post_mortem_lesson?: string;
  raw_onchain_data?: string;
  created_at?: string;
}

export interface SegmentedDbStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsd: number;
  totalProfitUsd: number;
  totalLossUsd: number;

  autoTradesCount: number;
  autoWins: number;
  autoLosses: number;
  autoWinRate: number;
  autoPnlUsd: number;
  autoProfitUsd: number;
  autoLossUsd: number;

  manualTradesCount: number;
  manualWins: number;
  manualLosses: number;
  manualWinRate: number;
  manualPnlUsd: number;
  manualProfitUsd: number;
  manualLossUsd: number;
}

export interface DbShockwaveEvent {
  id: string;
  event_type: 'VELOCITY_FREEZE' | 'BTC_SHOCK_SPILLOVER' | 'BLOW_OFF_TOP_HARVEST' | 'CASCADE_DEFENSE_EXIT' | 'EMERGENCY_PANIC_FREEZE' | 'L4_TRAP_VETO_COOLOFF' | 'DIRECTIONAL_BIAS_LOCK' | 'POST_HARVEST_COOLDOWN';
  symbol: string;
  velocity_atr: number;
  price_delta_pct: number;
  reason?: string;
  pnl_impact_usd?: number;
  details_json?: string;
  created_at: number;
}

class TradeDatabase {
  private db: DatabaseType | null = null;
  private readonly dbPath: string;
  private memoryTrades: Map<string, DbTrade> = new Map();

  constructor(customPath?: string) {
    this.dbPath = customPath || path.join(process.cwd(), 'data', 'trades.db');
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.initTables();
      logger.info(`Trade Database initialized with SQLite at ${this.dbPath}`);
    } catch (err: any) {
      logger.warn(`SQLite initialization failed (${err.message}). Using resilient in-memory store.`);
      this.db = null;
    }
  }

  private initTables(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        client_order_id TEXT,
        tx_version TEXT,
        market_address TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        is_manual INTEGER NOT NULL DEFAULT 0,
        entry_price REAL NOT NULL,
        exit_price REAL,
        size REAL NOT NULL,
        allocated_usd REAL NOT NULL,
        leverage REAL NOT NULL DEFAULT 1,
        realized_pnl REAL DEFAULT 0,
        realized_pnl_pct REAL DEFAULT 0,
        fee_usd REAL DEFAULT 0,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        strategy_name TEXT,
        strategy_tags TEXT,
        confidence INTEGER,
        entry_rationale TEXT,
        entry_snapshot TEXT,
        exit_reason TEXT,
        post_mortem_lesson TEXT,
        raw_onchain_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_is_manual ON trades(is_manual);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_tx_version ON trades(tx_version);
      CREATE INDEX IF NOT EXISTS idx_trades_client_order_id ON trades(client_order_id);

      CREATE TABLE IF NOT EXISTS custom_strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        version TEXT NOT NULL DEFAULT '1.0.0',
        author TEXT DEFAULT 'User',
        is_active INTEGER NOT NULL DEFAULT 0,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_strategies_active ON custom_strategies(is_active);

      CREATE TABLE IF NOT EXISTS pair_strategy_overrides (
        symbol TEXT PRIMARY KEY,
        overrides TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shockwave_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        velocity_atr REAL NOT NULL,
        price_delta_pct REAL NOT NULL,
        reason TEXT,
        pnl_impact_usd REAL DEFAULT 0,
        details_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_shockwave_created ON shockwave_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shockwave_symbol ON shockwave_events(symbol);
    `);

    try {
      this.db.exec(`ALTER TABLE shockwave_events ADD COLUMN reason TEXT;`);
    } catch { /* column already exists */ }

    try {
      this.db.exec(`
        UPDATE trades 
        SET is_manual = 0, 
            strategy_name = 'Turtle Soup & Liquidity Grab', 
            strategy_tags = '["template_turtle_soup"]' 
        WHERE is_manual = 1 
          AND (strategy_name = 'Manual Decibel Trade' OR strategy_name IS NULL OR strategy_name = '');
      `);
    } catch {}
  }

  /**
   * Insert or update a trade record
   */
  upsertTrade(t: DbTrade): void {
    if (!this.db) {
      const existing = this.memoryTrades.get(t.id) || {};
      this.memoryTrades.set(t.id, { ...existing, ...t });
      return;
    }

    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, client_order_id, tx_version, market_address, symbol, side, action,
        is_manual, entry_price, exit_price, size, allocated_usd, leverage,
        realized_pnl, realized_pnl_pct, fee_usd, status, opened_at, closed_at,
        strategy_name, strategy_tags, confidence, entry_rationale, entry_snapshot,
        exit_reason, post_mortem_lesson, raw_onchain_data
      ) VALUES (
        @id, @client_order_id, @tx_version, @market_address, @symbol, @side, @action,
        @is_manual, @entry_price, @exit_price, @size, @allocated_usd, @leverage,
        @realized_pnl, @realized_pnl_pct, @fee_usd, @status, @opened_at, @closed_at,
        @strategy_name, @strategy_tags, @confidence, @entry_rationale, @entry_snapshot,
        @exit_reason, @post_mortem_lesson, @raw_onchain_data
      )
      ON CONFLICT(id) DO UPDATE SET
        client_order_id = COALESCE(excluded.client_order_id, trades.client_order_id),
        tx_version = COALESCE(excluded.tx_version, trades.tx_version),
        market_address = COALESCE(excluded.market_address, trades.market_address),
        exit_price = COALESCE(excluded.exit_price, trades.exit_price),
        realized_pnl = COALESCE(excluded.realized_pnl, trades.realized_pnl),
        realized_pnl_pct = COALESCE(excluded.realized_pnl_pct, trades.realized_pnl_pct),
        fee_usd = COALESCE(excluded.fee_usd, trades.fee_usd),
        status = COALESCE(excluded.status, trades.status),
        closed_at = COALESCE(excluded.closed_at, trades.closed_at),
        strategy_name = COALESCE(excluded.strategy_name, trades.strategy_name),
        strategy_tags = COALESCE(excluded.strategy_tags, trades.strategy_tags),
        confidence = COALESCE(excluded.confidence, trades.confidence),
        entry_rationale = COALESCE(excluded.entry_rationale, trades.entry_rationale),
        entry_snapshot = COALESCE(excluded.entry_snapshot, trades.entry_snapshot),
        exit_reason = COALESCE(excluded.exit_reason, trades.exit_reason),
        post_mortem_lesson = COALESCE(excluded.post_mortem_lesson, trades.post_mortem_lesson),
        raw_onchain_data = COALESCE(excluded.raw_onchain_data, trades.raw_onchain_data)
    `);

    stmt.run({
      id: t.id,
      client_order_id: t.client_order_id ?? null,
      tx_version: t.tx_version ?? null,
      market_address: t.market_address ?? null,
      symbol: t.symbol,
      side: t.side,
      action: t.action,
      is_manual: t.is_manual ?? 0,
      entry_price: t.entry_price,
      exit_price: t.exit_price ?? null,
      size: t.size,
      allocated_usd: t.allocated_usd ?? 0,
      leverage: t.leverage ?? 1,
      realized_pnl: t.realized_pnl ?? 0,
      realized_pnl_pct: t.realized_pnl_pct ?? 0,
      fee_usd: t.fee_usd ?? 0,
      status: t.status,
      opened_at: t.opened_at,
      closed_at: t.closed_at ?? null,
      strategy_name: t.strategy_name ?? null,
      strategy_tags: t.strategy_tags ?? null,
      confidence: t.confidence ?? null,
      entry_rationale: t.entry_rationale ?? null,
      entry_snapshot: t.entry_snapshot ?? null,
      exit_reason: t.exit_reason ?? null,
      post_mortem_lesson: t.post_mortem_lesson ?? null,
      raw_onchain_data: t.raw_onchain_data ?? null,
    });
  }

  /**
   * Delete a trade record by ID
   */
  deleteTrade(id: string): boolean {
    if (!this.db) {
      return this.memoryTrades.delete(id);
    }
    const stmt = this.db.prepare('DELETE FROM trades WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }

  /**
   * Reconcile on-chain trade fills returned by Decibel MCP
   */
  syncOnChainTrades(onChainTrades: any[]): void {
    if (!Array.isArray(onChainTrades) || onChainTrades.length === 0) return;

    // Sort fills chronologically ascending so open fills precede close fills
    const sorted = [...onChainTrades].sort((a, b) => {
      const ta = Number(a.transaction_unix_ms || a.timestamp || 0);
      const tb = Number(b.transaction_unix_ms || b.timestamp || 0);
      return ta - tb;
    });

    for (const oct of sorted) {
      const clientOrderId = String(oct.client_order_id || '');
      const isAgent = oct.isManual !== undefined
        ? !oct.isManual
        : (oct.tradeType === 'AUTO' || (!clientOrderId.startsWith('manual-user-override') && !clientOrderId.startsWith('live-test') && !clientOrderId.startsWith('e2e')));
      const txVersion = oct.transaction_version ? String(oct.transaction_version) : undefined;
      const price = Number(oct.execution_price || oct.price || 0);
      const size = Number(oct.executed_size || oct.size || 0);
      const pnl = Number(oct.realized_pnl_amount || oct.pnlUsd || 0);
      const fee = Number(oct.fee_amount || oct.feeUsd || 0);
      const octAction = String(oct.action || '').toLowerCase();
      const isClose = octAction.includes('close');
      const isOpen = octAction.includes('open');

      let action: 'LONG' | 'SHORT' = 'LONG';
      let side: 'buy' | 'sell' = 'buy';

      if (octAction.includes('short')) {
        action = 'SHORT';
        side = octAction.includes('open') ? 'sell' : 'buy';
      } else if (octAction.includes('long')) {
        action = 'LONG';
        side = octAction.includes('close') ? 'sell' : 'buy';
      } else if (oct.side) {
        side = String(oct.side).toLowerCase() === 'sell' ? 'sell' : 'buy';
        action = side === 'sell' ? 'SHORT' : 'LONG';
      }

      const timestamp = Number(oct.transaction_unix_ms || oct.timestamp || Date.now());
      const rawSym = oct.symbol || 'DEX';
      const normSymbol = rawSym.replace('-', '/').toUpperCase();
      const altSymbol = rawSym.replace('/', '-').toUpperCase();

      if (this.db) {
        // 1. Try matching by exact client_order_id or tx_version
        let existing = this.db.prepare(`
          SELECT * FROM trades 
          WHERE (client_order_id IS NOT NULL AND client_order_id != '' AND client_order_id = ?) 
             OR id = ? 
             OR (tx_version IS NOT NULL AND tx_version != '' AND tx_version = ?)
          LIMIT 1
        `).get(clientOrderId, clientOrderId, txVersion || '') as any;

        // 2. If close fill and no exact match by ID, match active OPEN trade on same symbol
        if (!existing && isClose) {
          existing = this.db.prepare(`
            SELECT * FROM trades
            WHERE (symbol = ? OR symbol = ? OR symbol = ?)
              AND status = 'OPEN'
            ORDER BY opened_at DESC
            LIMIT 1
          `).get(normSymbol, altSymbol, rawSym) as any;
        }

        // 3. If open fill and no exact match by ID, check if a closed trade without entry_price exists
        if (!existing && isOpen) {
          existing = this.db.prepare(`
            SELECT * FROM trades
            WHERE (symbol = ? OR symbol = ? OR symbol = ?)
              AND ABS(opened_at - ?) < 3600000
            ORDER BY ABS(opened_at - ?) ASC
            LIMIT 1
          `).get(normSymbol, altSymbol, rawSym, timestamp, timestamp) as any;
        }

        if (existing) {
          if (isClose) {
            this.db.prepare(`
              UPDATE trades 
              SET tx_version = COALESCE(?, tx_version),
                  exit_price = ?,
                  closed_at = ?,
                  fee_usd = fee_usd + ?,
                  realized_pnl = ?,
                  status = 'CLOSED',
                  raw_onchain_data = ?,
                  action = ?,
                  side = ?
              WHERE id = ?
            `).run(txVersion || null, price, timestamp, fee, pnl, JSON.stringify(oct), action, side, existing.id);
          } else {
            // Open fill updates entry parameters
            this.db.prepare(`
              UPDATE trades 
              SET tx_version = COALESCE(tx_version, ?),
                  entry_price = CASE WHEN entry_price = 0 THEN ? ELSE entry_price END,
                  fee_usd = CASE WHEN fee_usd = 0 THEN ? ELSE fee_usd END,
                  opened_at = CASE WHEN opened_at = 0 THEN ? ELSE opened_at END,
                  raw_onchain_data = COALESCE(raw_onchain_data, ?)
              WHERE id = ?
            `).run(txVersion || null, price, fee, timestamp, JSON.stringify(oct), existing.id);
          }

          if (txVersion && existing.id !== `txn-${txVersion}`) {
            this.db.prepare("DELETE FROM trades WHERE id = ?").run(`txn-${txVersion}`);
          }
          continue;
        }
      }

      // Fallback: Insert new distinct on-chain trade with explicit strategy attribution
      const isManual = isAgent ? 0 : 1;
      const id = clientOrderId || (txVersion ? `txn-${txVersion}` : `oct-${oct.transaction_unix_ms}`);
      const fallbackStrategyName = isAgent ? 'Turtle Soup & Liquidity Grab' : 'Manual Decibel Trade';
      const fallbackStrategyTags = isAgent ? JSON.stringify(['template_turtle_soup']) : JSON.stringify(['Manual', 'On-Chain']);

      this.upsertTrade({
        id,
        client_order_id: clientOrderId || undefined,
        tx_version: txVersion || undefined,
        market_address: oct.market || undefined,
        symbol: normSymbol,
        side,
        action,
        is_manual: isManual,
        entry_price: price,
        exit_price: isClose ? price : undefined,
        size,
        allocated_usd: (price * size),
        leverage: 1,
        realized_pnl: pnl,
        fee_usd: fee,
        status: isClose ? 'CLOSED' : 'OPEN',
        opened_at: timestamp,
        closed_at: isClose ? timestamp : undefined,
        strategy_name: fallbackStrategyName,
        strategy_tags: fallbackStrategyTags,
        raw_onchain_data: JSON.stringify(oct),
      });
    }

    // Cleanup pass: prune false ghost/duplicate trades
    if (this.db) {
      try {
        // Prune manual duplicate placeholders where AI trade exists
        this.db.prepare(`
          DELETE FROM trades 
          WHERE is_manual = 1 
            AND id LIKE 'txn-%' 
            AND EXISTS (
              SELECT 1 FROM trades t2 
              WHERE t2.is_manual = 0 
                AND t2.symbol = trades.symbol 
                AND (ABS(t2.opened_at - trades.opened_at) < 600000 OR t2.tx_version = trades.tx_version)
                AND t2.id != trades.id
            )
        `).run();

        // Prune ghost open trades that were synthetically marked closed when an actual on-chain close fill exists for that symbol
        this.db.prepare(`
          DELETE FROM trades 
          WHERE (status = 'CLOSED_SL' OR status = 'CLOSED_MANUAL')
            AND realized_pnl < -1.0
            AND EXISTS (
              SELECT 1 FROM trades t2
              WHERE t2.symbol = trades.symbol
                AND t2.id != trades.id
                AND t2.status = 'CLOSED'
                AND t2.realized_pnl > -0.5
            )
        `).run();

      } catch {}
    }
  }

  /**
   * Query trades with optional filtering
   */
  getTrades(options?: { isManual?: boolean; symbol?: string; limit?: number; offset?: number }): DbTrade[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    if (!this.db) {
      let list = Array.from(this.memoryTrades.values());
      if (options?.isManual !== undefined) {
        list = list.filter((t) => (t.is_manual === 1) === options.isManual);
      }
      if (options?.symbol) {
        list = list.filter((t) => t.symbol === options.symbol);
      }
      list.sort((a, b) => b.opened_at - a.opened_at);
      return list.slice(offset, offset + limit);
    }

    let query = 'SELECT * FROM trades';
    const params: any = {};
    const conditions: string[] = [];

    if (options?.isManual !== undefined) {
      conditions.push('is_manual = @isManual');
      params.isManual = options.isManual ? 1 : 0;
    }

    if (options?.symbol) {
      conditions.push('symbol = @symbol');
      params.symbol = options.symbol;
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ' ORDER BY opened_at DESC LIMIT @limit OFFSET @offset';
    params.limit = limit;
    params.offset = offset;

    return this.db.prepare(query).all(params) as DbTrade[];
  }

  /**
   * Get full AI telemetry for a specific trade ID
   */
  getTradeTelemetry(id: string): DbTrade | null {
    if (!this.db) {
      for (const t of this.memoryTrades.values()) {
        if (t.id === id || t.client_order_id === id || t.tx_version === id) {
          return t;
        }
      }
      return null;
    }

    const stmt = this.db.prepare('SELECT * FROM trades WHERE id = ? OR client_order_id = ? OR tx_version = ?');
    const res = stmt.get(id, id, id) as DbTrade | undefined;
    return res || null;
  }

  /**
   * Aggregated dual P&L and win rate statistics
   */
  getSegmentedStats(): SegmentedDbStats {
    if (!this.db) {
      const closed = Array.from(this.memoryTrades.values()).filter((t) => t.status !== 'OPEN');
      const autoClosed = closed.filter((t) => t.is_manual === 0);
      const manClosed = closed.filter((t) => t.is_manual === 1);

      const calc = (arr: DbTrade[]) => {
        const wins = arr.filter((t) => (t.realized_pnl || 0) > 0).length;
        const losses = arr.filter((t) => (t.realized_pnl || 0) < 0).length;
        const totalPnl = arr.reduce((acc, t) => acc + (t.realized_pnl || 0), 0);
        const profit = arr.reduce((acc, t) => acc + ((t.realized_pnl || 0) > 0 ? (t.realized_pnl || 0) : 0), 0);
        const loss = arr.reduce((acc, t) => acc + ((t.realized_pnl || 0) < 0 ? (t.realized_pnl || 0) : 0), 0);
        const winRate = arr.length > 0 ? (wins / arr.length) * 100 : 0;
        return { count: arr.length, wins, losses, winRate, totalPnl, profit, loss };
      };

      const tStats = calc(closed);
      const aStats = calc(autoClosed);
      const mStats = calc(manClosed);

      return {
        totalTrades: tStats.count,
        wins: tStats.wins,
        losses: tStats.losses,
        winRate: Math.round(tStats.winRate * 10) / 10,
        totalPnlUsd: Math.round(tStats.totalPnl * 100) / 100,
        totalProfitUsd: Math.round(tStats.profit * 100) / 100,
        totalLossUsd: Math.round(tStats.loss * 100) / 100,

        autoTradesCount: aStats.count,
        autoWins: aStats.wins,
        autoLosses: aStats.losses,
        autoWinRate: Math.round(aStats.winRate * 10) / 10,
        autoPnlUsd: Math.round(aStats.totalPnl * 100) / 100,
        autoProfitUsd: Math.round(aStats.profit * 100) / 100,
        autoLossUsd: Math.round(aStats.loss * 100) / 100,

        manualTradesCount: mStats.count,
        manualWins: mStats.wins,
        manualLosses: mStats.losses,
        manualWinRate: Math.round(mStats.winRate * 10) / 10,
        manualPnlUsd: Math.round(mStats.totalPnl * 100) / 100,
        manualProfitUsd: Math.round(mStats.profit * 100) / 100,
        manualLossUsd: Math.round(mStats.loss * 100) / 100,
      };
    }

    const totalStmt = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(realized_pnl), 0) as totalPnl,
        COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) as profit,
        COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END), 0) as loss
      FROM trades
      WHERE status != 'OPEN'
    `);
    const total = totalStmt.get() as any;

    const autoStmt = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(realized_pnl), 0) as totalPnl,
        COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) as profit,
        COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END), 0) as loss
      FROM trades
      WHERE is_manual = 0 AND status != 'OPEN'
    `);
    const auto = autoStmt.get() as any;

    const manualStmt = this.db.prepare(`
      SELECT
        COUNT(*) as count,
        SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(realized_pnl), 0) as totalPnl,
        COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END), 0) as profit,
        COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END), 0) as loss
      FROM trades
      WHERE is_manual = 1 AND status != 'OPEN'
    `);
    const manual = manualStmt.get() as any;

    const winRate = total.count > 0 ? (total.wins / total.count) * 100 : 0;
    const autoWinRate = auto.count > 0 ? (auto.wins / auto.count) * 100 : 0;
    const manualWinRate = manual.count > 0 ? (manual.wins / manual.count) * 100 : 0;

    return {
      totalTrades: total.count || 0,
      wins: total.wins || 0,
      losses: total.losses || 0,
      winRate: Math.round(winRate * 10) / 10,
      totalPnlUsd: Math.round((total.totalPnl || 0) * 100) / 100,
      totalProfitUsd: Math.round((total.profit || 0) * 100) / 100,
      totalLossUsd: Math.round((total.loss || 0) * 100) / 100,

      autoTradesCount: auto.count || 0,
      autoWins: auto.wins || 0,
      autoLosses: auto.losses || 0,
      autoWinRate: Math.round(autoWinRate * 10) / 10,
      autoPnlUsd: Math.round((auto.totalPnl || 0) * 100) / 100,
      autoProfitUsd: Math.round((auto.profit || 0) * 100) / 100,
      autoLossUsd: Math.round((auto.loss || 0) * 100) / 100,

      manualTradesCount: manual.count || 0,
      manualWins: manual.wins || 0,
      manualLosses: manual.losses || 0,
      manualWinRate: Math.round(manualWinRate * 10) / 10,
      manualPnlUsd: Math.round((manual.totalPnl || 0) * 100) / 100,
      manualProfitUsd: Math.round((manual.profit || 0) * 100) / 100,
      manualLossUsd: Math.round((manual.loss || 0) * 100) / 100,
    };
  }

  /**
   * Migrate existing records from logs/trades_history.json if present
   */
  migrateFromJson(jsonFilePath?: string): void {
    const file = jsonFilePath || path.join(process.cwd(), 'logs', 'trades_history.json');
    if (!fs.existsSync(file)) return;

    try {
      const raw = fs.readFileSync(file, 'utf8');
      const trades = JSON.parse(raw);
      if (!Array.isArray(trades)) return;

      let migrated = 0;
      for (const t of trades) {
        if (!t.id && !t.orderId) continue;
        const id = t.id || t.orderId;
        this.upsertTrade({
          id,
          client_order_id: t.orderId || id,
          tx_version: t.txHash || undefined,
          symbol: t.symbol,
          side: t.side,
          action: t.action,
          is_manual: t.isManual ? 1 : 0,
          entry_price: t.entryPrice,
          exit_price: t.exitPrice,
          size: t.sizeBase,
          allocated_usd: t.allocatedUsd,
          leverage: t.leverage,
          realized_pnl: t.pnlUsd || 0,
          realized_pnl_pct: t.pnlPct || 0,
          status: t.status || 'CLOSED',
          opened_at: t.openedAt || Date.now(),
          closed_at: t.closedAt || Date.now(),
          strategy_name: t.strategyName,
          strategy_tags: t.strategyTags ? JSON.stringify(t.strategyTags) : undefined,
          confidence: t.confidence,
          entry_rationale: t.entryRationale,
          entry_snapshot: t.entrySnapshot ? JSON.stringify(t.entrySnapshot) : undefined,
          exit_reason: t.exitReason,
          post_mortem_lesson: t.postMortemLesson,
        });
        migrated++;
      }
      if (migrated > 0) {
        logger.info(`Migrated ${migrated} historical trades from JSON into SQLite database.`);
      }
    } catch (err: any) {
      logger.warn(`Failed to migrate JSON trade history: ${err.message}`);
    }
  }

  /**
   * Strategy Management in SQLite
   */
  saveCustomStrategy(strategy: any, isActive = false): void {
    const now = Date.now();
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO custom_strategies (id, name, description, version, author, is_active, config_json, created_at, updated_at)
        VALUES (@id, @name, @description, @version, @author, @is_active, @config_json, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          version = excluded.version,
          author = excluded.author,
          is_active = excluded.is_active,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `);
      stmt.run({
        id: strategy.id,
        name: strategy.name,
        description: strategy.description || '',
        version: strategy.version || '1.0.0',
        author: strategy.author || 'User',
        is_active: isActive ? 1 : 0,
        config_json: JSON.stringify(strategy),
        created_at: strategy.createdAt || now,
        updated_at: strategy.updatedAt || now,
      });
    } catch (err: any) {
      logger.warn(`Failed to save custom strategy to SQLite: ${err.message}`);
    }
  }

  getCustomStrategy(id: string): any | null {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT config_json FROM custom_strategies WHERE id = ?').get(id) as any;
      return row ? JSON.parse(row.config_json) : null;
    } catch {
      return null;
    }
  }

  getAllCustomStrategies(): any[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare('SELECT config_json FROM custom_strategies ORDER BY updated_at DESC').all() as any[];
      return rows.map((r) => JSON.parse(r.config_json));
    } catch {
      return [];
    }
  }

  deleteCustomStrategy(id: string): boolean {
    if (!this.db) return false;
    try {
      const info = this.db.prepare('DELETE FROM custom_strategies WHERE id = ?').run(id);
      return info.changes > 0;
    } catch {
      return false;
    }
  }

  setActiveStrategyId(id: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('UPDATE custom_strategies SET is_active = 0').run();
      this.db.prepare('UPDATE custom_strategies SET is_active = 1 WHERE id = ?').run(id);
    } catch (err: any) {
      logger.warn(`Failed to set active strategy ID in SQLite: ${err.message}`);
    }
  }

  getActiveStrategyId(): string | null {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT id FROM custom_strategies WHERE is_active = 1 LIMIT 1').get() as any;
      return row ? row.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Aggregate historical performance grouped by strategy from SQLite
   */
  getStrategyPerformance(): Record<string, any> {
    if (!this.db) return {};

    try {
      const rows = this.db.prepare(`
        SELECT 
          COALESCE(strategy_name, CASE WHEN is_manual = 1 THEN 'Manual Decibel Trade' ELSE 'Turtle Soup & Liquidity Grab' END) as sName,
          MAX(strategy_tags) as sTags,
          COUNT(*) as totalTrades,
          SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as openTrades,
          SUM(CASE WHEN status != 'OPEN' THEN 1 ELSE 0 END) as closedTrades,
          SUM(CASE WHEN status != 'OPEN' AND realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN status != 'OPEN' AND realized_pnl < 0 THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN status != 'OPEN' THEN realized_pnl ELSE 0 END) as netPnlUsd,
          SUM(CASE WHEN status != 'OPEN' AND realized_pnl > 0 THEN realized_pnl ELSE 0 END) as totalProfitUsd,
          SUM(CASE WHEN status != 'OPEN' AND realized_pnl < 0 THEN realized_pnl ELSE 0 END) as totalLossUsd,
          MAX(CASE WHEN status != 'OPEN' AND realized_pnl > 0 THEN realized_pnl ELSE 0 END) as bestTradePnl,
          MIN(CASE WHEN status != 'OPEN' AND realized_pnl < 0 THEN realized_pnl ELSE 0 END) as worstTradePnl,
          MAX(opened_at) as lastTradedAt
        FROM trades
        GROUP BY sName
      `).all() as any[];

      const result: Record<string, any> = {};
      for (const r of rows) {
        if (!r.sName) continue;
        const wins = Number(r.wins || 0);
        const closed = Number(r.closedTrades || 0);
        const winRatePct = closed > 0 ? Number(((wins / closed) * 100).toFixed(1)) : 0;
        const netPnlUsd = Number((r.netPnlUsd || 0).toFixed(4));
        const avgPnlUsd = closed > 0 ? Number((netPnlUsd / closed).toFixed(4)) : 0;

        let tags: string[] = [];
        try {
          if (r.sTags) tags = JSON.parse(r.sTags);
        } catch {}

        result[r.sName] = {
          strategyName: r.sName,
          strategyId: tags[0] || undefined,
          totalTrades: Number(r.totalTrades || 0),
          openTrades: Number(r.openTrades || 0),
          closedTrades: closed,
          wins,
          losses: Number(r.losses || 0),
          winRatePct,
          netPnlUsd,
          totalProfitUsd: Number((r.totalProfitUsd || 0).toFixed(4)),
          totalLossUsd: Number((r.totalLossUsd || 0).toFixed(4)),
          avgPnlUsd,
          bestTradePnl: Number((r.bestTradePnl || 0).toFixed(4)),
          worstTradePnl: Number((r.worstTradePnl || 0).toFixed(4)),
          lastTradedAt: r.lastTradedAt ? Number(r.lastTradedAt) : undefined,
        };
      }
      return result;
    } catch (err: any) {
      logger.warn(`Failed to query strategy performance from SQLite: ${err.message}`);
      return {};
    }
  }

  getPairOverrides(symbol: string): any | null {
    if (!this.db) return null;
    try {
      const row = this.db.prepare('SELECT overrides FROM pair_strategy_overrides WHERE symbol = ?').get(symbol) as any;
      return row ? JSON.parse(row.overrides) : null;
    } catch (err: any) {
      logger.warn(`Failed to get pair override for ${symbol}: ${err.message}`);
      return null;
    }
  }

  getAllPairOverrides(): Record<string, any> {
    if (!this.db) return {};
    try {
      const rows = this.db.prepare('SELECT symbol, overrides FROM pair_strategy_overrides').all() as any[];
      const res: Record<string, any> = {};
      for (const r of rows) {
        try {
          res[r.symbol] = JSON.parse(r.overrides);
        } catch {}
      }
      return res;
    } catch (err: any) {
      logger.warn(`Failed to get all pair overrides: ${err.message}`);
      return {};
    }
  }

  savePairOverride(symbol: string, overrides: any): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO pair_strategy_overrides (symbol, overrides, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          overrides = excluded.overrides,
          updated_at = excluded.updated_at
      `).run(symbol, JSON.stringify(overrides), Date.now());
    } catch (err: any) {
      logger.error(`Failed to save pair override for ${symbol}: ${err.message}`);
    }
  }

  deletePairOverride(symbol: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM pair_strategy_overrides WHERE symbol = ?').run(symbol);
    } catch (err: any) {
      logger.error(`Failed to delete pair override for ${symbol}: ${err.message}`);
    }
  }

  deleteAllPairOverrides(): void {
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM pair_strategy_overrides').run();
    } catch (err: any) {
      logger.error(`Failed to delete all pair overrides: ${err.message}`);
    }
  }

  clearAllTrades(): void {
    if (!this.db) {
      this.memoryTrades.clear();
      return;
    }
    try {
      this.db.prepare('DELETE FROM trades').run();
    } catch (err: any) {
      logger.error(`Failed to clear trades in SQLite: ${err.message}`);
    }
  }

  recordShockwaveEvent(event: DbShockwaveEvent): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO shockwave_events (id, event_type, symbol, velocity_atr, price_delta_pct, reason, pnl_impact_usd, details_json, created_at)
        VALUES (@id, @event_type, @symbol, @velocity_atr, @price_delta_pct, @reason, @pnl_impact_usd, @details_json, @created_at)
        ON CONFLICT(id) DO UPDATE SET
          pnl_impact_usd = excluded.pnl_impact_usd,
          details_json = excluded.details_json,
          reason = excluded.reason
      `).run({
        id: event.id,
        event_type: event.event_type,
        symbol: event.symbol,
        velocity_atr: event.velocity_atr,
        price_delta_pct: event.price_delta_pct,
        reason: event.reason ?? null,
        pnl_impact_usd: event.pnl_impact_usd ?? 0,
        details_json: event.details_json ?? null,
        created_at: event.created_at || Date.now(),
      });
      logger.info(`⚡ [SHOCK DB] Recorded ${event.event_type} on ${event.symbol} (Vel: ${event.velocity_atr.toFixed(2)}x ATR, $\\Delta$: ${event.price_delta_pct.toFixed(2)}%)`);
    } catch (err: any) {
      logger.error(`Failed to record shockwave event: ${err.message}`);
    }
  }

  getRecentShockwaveEvents(limit: number = 50): DbShockwaveEvent[] {
    if (!this.db) return [];
    try {
      return this.db.prepare('SELECT * FROM shockwave_events ORDER BY created_at DESC LIMIT ?').all(limit) as DbShockwaveEvent[];
    } catch (err: any) {
      logger.error(`Failed to load recent shockwave events: ${err.message}`);
      return [];
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

export const dbClient = new TradeDatabase();
