/**
 * Trading Agent Copilot Engine (Client V3)
 * Answers trading questions, provides real-time market rationale,
 * explains strategies, and executes dashboard runtime controls.
 */

import { tradeExecutor } from '../trades/executor';
import { portfolioHarvester } from '../engine/harvester';
import { standaloneEngine } from '../engine/standalone-engine';
import { superchargeClient } from '../simlab/supercharge-client';
import { getActiveStrategy, getAllStrategies } from '../strategy/manager';
import { logger } from '../utils/logger';

let pauseHandler: ((paused: boolean) => void) | null = null;
let scanHandler: (() => Promise<void>) | null = null;

export function registerCopilotHandlers(handlers: {
  setPaused: (paused: boolean) => void;
  triggerScan: () => Promise<void>;
}): void {
  pauseHandler = handlers.setPaused;
  scanHandler = handlers.triggerScan;
}

export interface CopilotResponse {
  reply: string;
  actionTaken?: string;
  timestamp: number;
}

function fmtPnl(val: number): string {
  if (val > 0) return `+$${val.toFixed(2)}`;
  if (val < 0) return `-$${Math.abs(val).toFixed(2)}`;
  return '$0.00';
}

export async function processUserMessage(rawQuery: string, source: 'web' | 'telegram' = 'web'): Promise<CopilotResponse> {
  const query = rawQuery.trim();
  const lower = query.toLowerCase();

  // ─── 1. Control Commands ───────────────────────────────────────────────────

  // Pause / Resume
  if (/(?:pause|halt|freeze|stop trading)/i.test(lower) && !/(?:status|how|check)/i.test(lower)) {
    if (pauseHandler) pauseHandler(true);
    return {
      reply: '🛑 **Trading paused.** The agent will continue to manage open positions and monitor stop-losses, but will not enter any new trades until resumed.',
      actionTaken: 'pause',
      timestamp: Date.now(),
    };
  }

  if (/(?:resume|unpause|start trading|continue)/i.test(lower) && !/(?:status|how|check)/i.test(lower)) {
    if (pauseHandler) pauseHandler(false);
    return {
      reply: '▶️ **Trading resumed.** The agent is actively scanning markets and evaluating trade opportunities.',
      actionTaken: 'resume',
      timestamp: Date.now(),
    };
  }

  // Scan trigger
  if (/(?:scan now|trigger scan|check market|evaluate now|run scan)/i.test(lower)) {
    if (scanHandler) {
      scanHandler().catch(() => {});
      return {
        reply: '⚡ **Manual market scan triggered.** Analyzing orderbooks, SMC structures, and indicators now.',
        actionTaken: 'scan',
        timestamp: Date.now(),
      };
    }
  }

  // ─── 2. Status & Position Queries ──────────────────────────────────────────

  // Open positions
  if (/(?:open positions|my positions|active trades|what's open|current trades|portfolio)/i.test(lower)) {
    const openTrades = tradeExecutor.getOpenTrades();
    if (openTrades.length === 0) {
      return {
        reply: '📊 **No open positions.** The bot is monitoring candidate pairs and awaiting high-conviction entry criteria.',
        timestamp: Date.now(),
      };
    }

    const harvesterState = portfolioHarvester.evaluate();
    let text = `### 🎯 Open Positions (${openTrades.length})\n\n`;
    for (const t of openTrades) {
      const p = harvesterState.positions[t.symbol] || harvesterState.positions[t.id];
      const pnlStr = fmtPnl(t.pnlUsd || 0);
      const score = p ? p.score : 'N/A';
      const badge = p ? (p.recommendation === 'RUNNER' ? '🟢 RUNNER' : p.recommendation === 'HARVEST' ? '🌾 HARVEST' : '⚖️ HOLD') : '⚖️ HOLD';
      text += `- **${t.symbol} ${t.action}** | PnL: **${pnlStr}** (${(t.pnlPct || 0).toFixed(2)}%) | Vulnerability: **${score}/100** [${badge}]\n`;
      text += `  • Entry: $${t.entryPrice} | TP: $${t.takeProfit || 'None'} | SL: $${t.stopLoss || 'None'}\n`;
      if (p && p.factors && p.factors.length > 0) {
        text += `  • *Factors: ${p.factors.slice(0, 3).join(', ')}*\n`;
      }
    }
    return { reply: text, timestamp: Date.now() };
  }

  // Performance & Stats
  if (/(?:pnl|performance|win rate|stats|profit|losses|winrate|history)/i.test(lower)) {
    const stats = tradeExecutor.getStats();
    const closed = tradeExecutor.getClosedTrades();
    let text = `### 📈 Performance Telemetry\n\n`;
    text += `- **Total Realized PnL:** **${fmtPnl(stats.totalPnlUsd)}**\n`;
    text += `- **Win Rate:** **${stats.winRate.toFixed(1)}%** (${stats.wins}W / ${stats.losses}L across ${stats.closedTradesCount} closed trades)\n`;
    text += `- **Active Positions:** ${stats.openTradesCount}\n`;
    text += `- **Budget Deployed:** $${stats.budgetUsedUsd.toFixed(2)} (Available: $${stats.budgetAvailableUsd.toFixed(2)})\n\n`;

    if (closed.length > 0) {
      text += `#### Recent Closed Trades:\n`;
      for (const t of closed.slice(0, 4)) {
        text += `- **${t.symbol} ${t.action}**: ${fmtPnl(t.pnlUsd || 0)} (${(t.pnlPct || 0).toFixed(2)}%) — Reason: \`${t.exitReason || 'Exit'}\`\n`;
      }
    }
    return { reply: text, timestamp: Date.now() };
  }

  // ─── 3. Sim Lab & Alpha Bundle Queries ──────────────────────────────────────
  if (/(?:sim lab|pipeline|port 4000|alpha bundle|sim status|supercharge|fleet)/i.test(lower)) {
    const isConn = superchargeClient.isActive();
    const sUrl = superchargeClient.getServerUrl();
    const flags = superchargeClient.getFeatureFlags();
    const dirs = standaloneEngine.getDirectives();

    let text = `### 🔬 Sim Lab AI Supercharge & Alpha Bundle Status (Client V3)\n\n`;
    text += `- **Connection Status:** ${isConn ? '🟢 **AUTHENTICATED & SUPERCHARGED**' : '🟡 **PURE STANDALONE MODE**'}\n`;
    text += `- **Target Endpoint:** \`${sUrl}\`\n`;
    text += `- **Active Operating Mode:** \`${dirs.source}\`\n`;
    text += `- **Active Strategy:** **${dirs.activeStrategy}**\n`;
    text += `- **Macro Market Regime:** **${dirs.regime}**\n`;
    text += `- **Score Floor Gate:** **${dirs.scoreFloor}%**\n`;
    text += `- **Wick Trap Tolerance:** **${dirs.bullTrapUpperWickPct}%**\n`;
    text += `- **Directional Bans:** ${dirs.bannedSides && dirs.bannedSides.length > 0 ? `\`${dirs.bannedSides.join(', ')}\`` : 'None (All sides permitted)'}\n\n`;

    text += `#### 🎛️ Active Feature Toggles:\n`;
    text += `- Macro Regime Sync: ${flags.syncMacroRegime ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Dynamic Indicators Sync: ${flags.syncIndicators ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Directional Bans Sync: ${flags.syncDirectionalBans ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Pre-Trade Counterfactual Veto: ${flags.syncCounterfactual ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- 8s Telemetry Heartbeat: ${flags.syncTelemetry ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Remote Strategy Studio: ${flags.syncStrategyStudio ? '✅ Enabled' : '❌ Disabled'}\n`;

    return { reply: text, timestamp: Date.now() };
  }

  // ─── 4. Harvester Queries ──────────────────────────────────────────────────
  if (/(?:harvester|harvest|profit lock|vulnerability|trailing)/i.test(lower)) {
    const hState = portfolioHarvester.evaluate();
    const cfg = portfolioHarvester.getConfig();
    let text = `### 🌾 Portfolio Harvester Master (Client V3)\n\n`;
    text += `- **Engine Status:** **${hState.status}** (${cfg.enabled ? 'Enabled' : 'Paused'})\n`;
    text += `- **Sync Mode:** \`${cfg.syncMode}\` | Execution Style: \`${cfg.executionStyle}\`\n`;
    text += `- **Harvest Score Threshold:** **≥${cfg.harvestScoreThreshold}/100**\n`;
    text += `- **Runner Score Threshold:** **<${cfg.runnerScoreThreshold}/100**\n`;
    text += `- **Min Net Harvest ROI:** **+${cfg.minHarvestPct}%** ($${cfg.minHarvestUsd} min profit)\n`;
    text += `- **Breakeven Acceleration:** **${cfg.accelerateBreakevenR}R**\n`;
    text += `- **Defensive Bleed Cutting:** **Active** (Emergency exit if PnL ≤ -3.0% & Score ≥ 65)\n\n`;

    if (hState.positionsList.length > 0) {
      text += `#### Live Position Vulnerability:\n`;
      for (const p of hState.positionsList) {
        text += `- **${p.symbol}**: Score **${p.score}/100** [${p.recommendation}] | Net ${p.netPnlUsd >= 0 ? '+' : ''}$${p.netPnlUsd} — *${p.factors.join(', ')}*\n`;
      }
    }
    return { reply: text, timestamp: Date.now() };
  }

  // Default fallback
  const currentStrat = getActiveStrategy();
  return {
    reply: `👋 **Decibel Autonomous Copilot (Client V3)** online.\n\n` +
      `Active Strategy: **${currentStrat ? currentStrat.name : 'Autonomous SMC & Momentum'}** | ` +
      `Open Positions: **${tradeExecutor.getOpenTrades().length}**\n\n` +
      `You can ask me:\n` +
      `• *"open positions"* or *"pnl"* to review portfolio health\n` +
      `• *"sim lab"* or *"alpha bundle"* to check Port 4000 connection\n` +
      `• *"harvester"* to check vulnerability scores & bleed cutting\n` +
      `• *"pause trading"* or *"resume trading"* to control execution`,
    timestamp: Date.now(),
  };
}
