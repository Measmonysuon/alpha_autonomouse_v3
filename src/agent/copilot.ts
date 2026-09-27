/**
 * Trading Agent Copilot Engine (Client V3)
 * Answers trading questions, provides real-time market rationale,
 * explains strategies, and executes dashboard runtime controls.
 */

import { tradeExecutor } from '../trades/executor';
import { portfolioHarvester } from '../engine/harvester';
import { standaloneEngine } from '../engine/standalone-engine';
import { superchargeClient } from '../simlab/supercharge-client';
import {
  getActiveStrategy,
  getAllStrategies,
  getAllPairOverrides,
  resetAllPairOverrides,
  resetPairOverride,
  getPairOverrides,
  getSimPairDirectives,
  getSimPairDirective,
} from '../strategy/manager';
import { riskGuard } from '../risk/guard';
import { config } from '../config';
import { logger } from '../utils/logger';
import { agentState, pushLog } from '../api-server';
import { localAIBrain } from '../ai/brain';

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

  // Emergency / Shockwave Panic Freeze: "panic freeze 30m", "freeze 15m", "cool off 1h", "emergency stop"
  const isStatusInquiry = /(status|check|report|what|how|remaining|radar|tell me|show|list)/i.test(lower);
  const shockFreezeMatch = !isStatusInquiry && (
    lower.match(/^(?:panic freeze|emergency freeze|shock freeze)\s*(\d+)?\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i) ||
    lower.match(/^(?:cool off|freeze all)\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i) ||
    lower.match(/^freeze\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i) ||
    lower.match(/^(?:emergency stop|panic stop)$/i)
  );

  if (shockFreezeMatch) {
    let durMinutes = 15;
    if (shockFreezeMatch[1]) {
      const num = parseInt(shockFreezeMatch[1], 10);
      const unit = shockFreezeMatch[2] ? shockFreezeMatch[2].toLowerCase() : 'm';
      if (unit.startsWith('h')) durMinutes = num * 60;
      else durMinutes = num;
    }
    durMinutes = Math.max(1, Math.min(1440, durMinutes));
    
    // Pause execution and lock pairs in risk guard
    if (pauseHandler) pauseHandler(true);
    tradeExecutor.setPaused(true);
    agentState.status = 'paused';

    const watchPairs = agentState.pairs || config.WATCH_PAIRS.split(',').map((s: string) => s.trim());
    for (const sym of watchPairs) {
      riskGuard.triggerL4TrapCoolOff(sym, 'BOTH', 'MANUAL_PANIC_FREEZE', `Triggered by Copilot user command (${source})`, durMinutes);
    }
    pushLog('warn', `🚨 Manual panic freeze activated for ${durMinutes}m via Copilot`);

    return {
      reply: `🚨 **EMERGENCY PANIC FREEZE ACTIVATED (${durMinutes} Minutes)**\n\n` +
        `• All new trade signals across **ALL PAIRS** are frozen until **${new Date(Date.now() + durMinutes * 60000).toLocaleTimeString()}**.\n` +
        `• Master Harvester remains vigilant to guard active trades and lock in spike profits.\n` +
        `• Type **"resume"** or **"unfreeze"** to clear the freeze at any time.`,
      actionTaken: 'panic_freeze',
      timestamp: Date.now(),
    };
  }

  // Pause
  if (/^(?:pause|stop trading|halt)$/i.test(lower)) {
    if (pauseHandler) pauseHandler(true);
    tradeExecutor.setPaused(true);
    agentState.status = 'paused';
    pushLog('warn', '⏸ Trading agent paused via dashboard Copilot');
    return {
      reply: '⏸ **Autonomous trading has been PAUSED.**\n\nThe agent will continue monitoring markets and calculating confidence scores, but will NOT open any new positions until you resume.',
      actionTaken: 'pause',
      timestamp: Date.now(),
    };
  }

  // Resume
  if (/^(?:resume|start trading|unpause|continue|unfreeze)$/i.test(lower)) {
    if (pauseHandler) pauseHandler(false);
    tradeExecutor.setPaused(false);
    agentState.status = 'running';
    pushLog('info', '▶ Trading agent resumed via dashboard Copilot');
    const dirs = standaloneEngine.getDirectives();
    return {
      reply: '▶ **Autonomous trading has been RESUMED.**\n\nAll executions are active. The agent will automatically open positions whenever a pair scores ≥ ' + (dirs.scoreFloor ?? agentState.minConfidencePct ?? 75) + '% confidence.',
      actionTaken: 'resume',
      timestamp: Date.now(),
    };
  }

  // Scan Now
  if (/(?:scan now|scan|trigger scan|check markets now|refresh markets|evaluate now)/i.test(lower)) {
    if (scanHandler) {
      pushLog('info', '⚡ Manual scan triggered via dashboard Copilot');
      scanHandler().catch((err: any) => logger.error(`Manual scan error: ${err.message}`));
      return {
        reply: '⚡ **Triggered market scan across all pairs now!**\n\nAnalyzing live order books, SMC liquidity pools, and indicator confluence across all 28 Aptos markets.',
        actionTaken: 'scan',
        timestamp: Date.now(),
      };
    }
  }

  // Set Confidence: "set confidence 75", "change confidence to 85%"
  const confMatch = lower.match(/set confidence\s*(?:to)?\s*(\d+)/i) || lower.match(/confidence\s*(\d+)%/i);
  if (confMatch) {
    const val = parseInt(confMatch[1], 10);
    if (val >= 50 && val <= 100) {
      agentState.minConfidencePct = val;
      standaloneEngine.updateDirectivesFromSimLab({ scoreFloor: val });
      pushLog('info', `🎯 Min confidence threshold updated to ${val}% via Copilot`);
      return {
        reply: `🎯 **Minimum confidence threshold updated to ${val}%.**\n\nThe agent will now require $\\ge ${val}\\%$ signal confidence before opening any trade.`,
        actionTaken: 'set_confidence',
        timestamp: Date.now(),
      };
    } else {
      return {
        reply: `⚠️ Confidence must be set between **50% and 100%**. Current threshold: **${agentState.minConfidencePct ?? 75}%**.`,
        timestamp: Date.now(),
      };
    }
  }

  // ─── Pair Strategy Overrides Commands ─────────────────────────────────────
  if (/(?:pair overrides|custom pair|pair strategies|pair settings|show pair)/i.test(lower)) {
    const overrides = getAllPairOverrides();
    const active = getActiveStrategy();
    const keys = Object.keys(overrides);
    if (keys.length === 0) {
      return {
        reply: `🌐 **No custom pair overrides active.**\n\nAll pairs are currently executing with global strategy **"${active.name}"**.\n\n*Tip: Flip any pair card on the dashboard to customize rules per-pair.*`,
        timestamp: Date.now(),
      };
    }
    let reply = `### 🎛️ Active Pair Strategy Overrides (Global: "${active.name}"):\n\n`;
    for (const s of keys) {
      const o = overrides[s];
      const l1 = typeof o.layer1 === 'boolean' ? (o.layer1 ? '🟢 L1 (TA): ON' : '⚪ L1 (TA): OFF') : '🌐 L1: Global';
      const l2 = typeof o.layer2 === 'boolean' ? (o.layer2 ? '🟢 L2 (Liq): ON' : '⚪ L2 (Liq): OFF') : '🌐 L2: Global';
      const l3 = typeof o.layer3 === 'boolean' ? (o.layer3 ? '🟢 L3 (SMC): ON' : '⚪ L3 (SMC): OFF') : '🌐 L3: Global';
      const l4 = typeof o.layer4 === 'boolean' ? (o.layer4 ? '🟢 L4 (AI): ON' : '⚪ L4 (AI): OFF') : '🌐 L4: Global';
      reply += `- **${s}**:\n  • ${l1} | ${l2} | ${l3} | ${l4}\n  • 🔒 L5 (Risk & SL): LOCKED ON\n`;
    }
    return { reply, timestamp: Date.now() };
  }

  if (/(?:reset all pair|reset all pairs|reset pair overrides|sync all pairs|clear all pair overrides)/i.test(lower)) {
    const active = getActiveStrategy();
    resetAllPairOverrides();
    pushLog('info', '↺ Reset all pair strategy overrides via Copilot');
    return {
      reply: `↺ **Reset all pair strategy overrides to Global Strategy defaults!**\n\nAll trading pairs are now synchronized with active Global Strategy **"${active.name}"** (Layer 2: **${active.layer2.enabled ? 'ON 🟢' : 'OFF ⚪'}**).`,
      actionTaken: 'reset_all_pair_overrides',
      timestamp: Date.now(),
    };
  }

  const resetMatch = lower.match(/reset\s*(?:pair\s*)?([a-z0-9]+(?:\/[a-z0-9]+)?)/i);
  if (resetMatch && !resetMatch[1].includes('all') && !resetMatch[1].includes('strategy')) {
    let sym = resetMatch[1].toUpperCase();
    if (!sym.includes('/')) sym = `${sym}/USD`;
    const prev = getPairOverrides(sym);
    if (prev) {
      resetPairOverride(sym);
      pushLog('info', `↺ Reset pair strategy override for ${sym} via Copilot`);
      return {
        reply: `↺ **Reset ${sym} strategy to Global Strategy defaults.**\n\nAll 5 layers are now synchronized with the active studio template.`,
        actionTaken: 'reset_pair_override',
        timestamp: Date.now(),
      };
    }
  }

  // ─── 2. Deterministic Domain Handlers ─────────────────────────────────────

  // ─── A. "Why no trades yet?" ──────────────────────────────────────────────
  if (/(?:why no trades|why haven't you traded|why not trading|why wait|why waiting|any trades|why haven't we traded)/i.test(lower)) {
    const activeStrat = getActiveStrategy();
    const dirs = standaloneEngine.getDirectives();
    const baseGate = dirs.scoreFloor || (typeof activeStrat?.layer5?.minConfidenceGate === 'number'
      ? activeStrat.layer5.minConfidenceGate
      : (agentState.minConfidencePct ?? 75));
    const macroBuffer = dirs.regime === 'RANGING_CHOP' || dirs.regime === 'HIGH_VOLATILITY' ? 5 : 0;
    const effectiveGate = baseGate + macroBuffer;
    const shieldArm = Math.max(50, baseGate - 5);
    const markets = Object.values(agentState.markets || {});
    const open = tradeExecutor.getOpenTrades();
    const budget = agentState.budgetUsd || config.BUDGET_USD || 100;

    let text = `### 🛡️ Why the Agent Has Not Entered Any Trades Yet:\n\n`;
    text += `**Dynamic Safety Gate:** The agent enforces an **Effective Min Score of ${effectiveGate}%** (${baseGate}% Strategy Base + ${macroBuffer >= 0 ? '+' : ''}${macroBuffer}% AI Macro Buffer for \`${dirs.regime}\` conditions) to protect your $${budget.toFixed(2)} capital against false breakouts.\n\n`;

    if (tradeExecutor.getIsPaused() || agentState.status === 'paused') {
      text += `⚠️ **Notice:** Trading is currently **PAUSED**. Type \`resume\` or click Resume to reactivate.\n\n`;
    }

    if (dirs.bannedSides && dirs.bannedSides.length > 0) {
      text += `🚫 **Directional Ban Active:** Fleet-wide restriction on **\`${dirs.bannedSides.join(', ')}\`** positions to protect against regime headwinds.\n\n`;
    }

    if (open.length > 0) {
      text += `📂 You currently have **${open.length} active position(s)** open. Check the Positions tab or Harvester for live P&L.\n\n`;
    }

    text += `#### Current Pair Confidence vs ${effectiveGate}% Effective Gate:\n`;
    if (markets.length === 0) {
      text += `- *Scanning in progress... please wait a few moments for the cycle to populate.*\n`;
    } else {
      // Sort pairs by highest confidence first
      const sorted = [...markets].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      for (const m of sorted) {
        const gap = effectiveGate - (m.confidence || 0);
        const icon = m.confidence >= effectiveGate ? '🟢' : m.confidence >= shieldArm ? '🛡️' : m.confidence >= 50 ? '🟡' : '⚪';
        const shieldNote = m.confidence >= shieldArm ? ' [AI Trap Shield Armed]' : '';
        text += `- ${icon} **${m.symbol}**: **${m.confidence}%** (Mark: $${m.markPrice}, Trend: \`${m.trend}\`, Risk: \`${m.riskLevel}\`${shieldNote}) → *${m.confidence >= effectiveGate ? 'READY TO TRADE' : `Needs +${gap}% more confluence`}*\n`;
      }
    }

    text += `\n**Dynamic AI Trap Shield Guardrail:**\n`;
    text += `Any candidate setup scoring **${shieldArm}%+** (5% below the ${baseGate}% strategy gate) is automatically interrogated by the **Layer 4 Adversarial Trap Shield** before execution. If a trap, fakeout, or spoofed book is detected, confidence is crushed to **${Math.max(35, baseGate - 15)}%** to prevent bad trades.\n\n`;
    text += `💡 *Capital preservation is working as designed — zero bad trades are placed during chop or unconfirmed momentum.*`;
    return { reply: text, timestamp: Date.now() };
  }

  // ─── B. Budget & Risk Overview ─────────────────────────────────────────────
  if (/(?:budget|risk overview|equity|margin overview|available margin|how much capital|capital allocation|show my budget)/i.test(lower)) {
    const stats = tradeExecutor.getStats();
    const totalBudget = agentState.budgetUsd || config.BUDGET_USD || 100;
    const equity = agentState.accountEquityUsd > 0 ? agentState.accountEquityUsd : totalBudget;
    const avail = agentState.availableMarginUsd > 0 ? agentState.availableMarginUsd : Math.max(0, totalBudget - stats.budgetUsedUsd);
    const minA = agentState.minAllocPct || config.MIN_ALLOC_PCT || 15;
    const maxA = agentState.maxAllocPct || config.MAX_ALLOC_PCT || 25;
    const minUsd = (minA / 100 * totalBudget).toFixed(2);
    const maxUsd = (maxA / 100 * totalBudget).toFixed(2);
    const maxLev = config.MAX_LEVERAGE || 5;

    return {
      reply: `### 💰 Capital & Risk Management Overview\n\n` +
        `| Metric | Value |\n` +
        `| :--- | :--- |\n` +
        `| **Live Account Equity** | **$${equity.toFixed(2)}** |\n` +
        `| **Available Margin** | **$${avail.toFixed(2)}** |\n` +
        `| **Working Budget** | **$${totalBudget.toFixed(2)}** (Auto-synced) |\n` +
        `| **Budget Deployed** | **$${stats.budgetUsedUsd.toFixed(2)}** (${stats.openTradesCount || stats.openTrades || 0} open) |\n` +
        `| **Budget Free** | **$${stats.budgetAvailableUsd.toFixed(2)}** |\n` +
        `| **Allocation / Trade** | **${minA}% – ${maxA}%** ($${minUsd} – $${maxUsd}) |\n` +
        `| **Confidence Gate** | **${agentState.minConfidencePct ?? 75}%** |\n` +
        `| **Leverage Hard Ceiling** | **${maxLev}x Max** (Enforced by Layer 5) |\n` +
        `| **Max Open Positions** | 4 concurrent positions max |\n\n` +
        `🔒 *Every order is sized according to dynamic account equity with automated Stop-Loss, Take-Profit, and Maker-First PostOnly routing to eliminate taker fee drag.*`,
      timestamp: Date.now(),
    };
  }

  // ─── C. Market / Price Analysis ───────────────────────────────────────────
  if (/(?:market overview|live market|price overview|coin overview|pairs overview|scan results|show live market)/i.test(lower) ||
      (/(?:market|price|coin|pairs)/i.test(lower) && !/(?:budget|risk|position|pnl|stat|strategy|shield|harvester)/i.test(lower))) {
    const markets = Object.values(agentState.markets || {});
    if (!markets.length) {
      return {
        reply: '📊 No market data loaded yet. The agent is initializing the scan cycle.',
        timestamp: Date.now(),
      };
    }

    let text = `### 📊 Live Market & Scan Overview\n\n`;
    text += `| Pair | Mark Price | 24h Change | Trend | Action | Confidence | Risk Level |\n`;
    text += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    for (const m of markets) {
      const chg = m.change24h ? (m.change24h >= 0 ? `+${m.change24h.toFixed(2)}%` : `${m.change24h.toFixed(2)}%`) : '0.00%';
      text += `| **${m.symbol}** | $${m.markPrice} | ${chg} | \`${m.trend}\` | \`${m.action}\` | **${m.confidence}%** | \`${m.riskLevel}\` |\n`;
    }

    text += `\n*Scanned pairs: ${(agentState.pairs || agentState.currentPairs || []).join(', ')}*\n`;
    text += `*Cycle count: #${agentState.cycleCount || 1} (Updates every 15s)*`;
    return { reply: text, timestamp: Date.now() };
  }

  // ─── D. Open Positions ────────────────────────────────────────────────────
  if (/(?:position|open trade|current trade|active trade|do we have open positions|what's open)/i.test(lower)) {
    const open = tradeExecutor.getOpenTrades();
    if (!open.length) {
      const dirs = standaloneEngine.getDirectives();
      return {
        reply: `📭 **No active positions open right now.**\n\nThe agent is scanning the order books and SMC liquidity pools waiting for an $\\ge ${dirs.scoreFloor}%$ confluence setup.`,
        timestamp: Date.now(),
      };
    }

    const harvesterState = portfolioHarvester.evaluate();
    let text = `### 📂 Open Positions (${open.length})\n\n`;
    for (const t of open) {
      const emoji = t.action === 'LONG' ? '🟢' : '🔴';
      const age = Math.floor((Date.now() - (t.openedAt || Date.now())) / 60000);
      const p = harvesterState.positions[t.symbol] || harvesterState.positions[t.id];
      const badge = p ? (p.recommendation === 'RUNNER' ? '🟢 RUNNER' : p.recommendation === 'HARVEST' ? '🌾 HARVEST' : '⚖️ HOLD') : '⚖️ HOLD';
      const score = p ? `${p.score}/100` : 'Normal';

      text += `#### ${emoji} **${t.symbol}** (${t.action} ${t.leverage}x)\n`;
      text += `- **Entry Price**: $${Number(t.entryPrice).toFixed(4)}\n`;
      text += `- **Capital Allocated**: $${Number(t.allocatedUsd || 0).toFixed(2)} (Notional: $${Number(t.sizeUsd || (t.allocatedUsd * t.leverage) || 0).toFixed(2)})\n`;
      text += `- **Take Profit**: $${t.takeProfit ? Number(t.takeProfit).toFixed(4) : 'None'}\n`;
      text += `- **Stop Loss**: $${t.stopLoss ? Number(t.stopLoss).toFixed(4) : 'None'}\n`;
      text += `- **Harvester Vulnerability**: **${score}** [${badge}]\n`;
      if (t.strategyName) text += `- **Strategy**: *${t.strategyName}*\n`;
      text += `- **Duration**: Open for ${age} minute(s)\n\n`;
    }
    return { reply: text, timestamp: Date.now() };
  }

  // ─── E. Performance & Stats ───────────────────────────────────────────────
  if (/(?:performance|stats|win rate|history|profit|loss|pnl|net pnl|what is our win rate)/i.test(lower)) {
    const stats = tradeExecutor.getStats();
    const closed = tradeExecutor.getClosedTrades();
    const shadowStats = tradeExecutor.getShadowStats();

    const autoWins = (stats as any).autoWins ?? 0;
    const autoLosses = (stats as any).autoLosses ?? 0;
    const manualWins = (stats as any).manualWins ?? 0;
    const manualLosses = (stats as any).manualLosses ?? 0;
    const autoPnlUsd = (stats as any).autoPnlUsd ?? 0;
    const manualPnlUsd = (stats as any).manualPnlUsd ?? 0;
    const autoWinRate = autoWins + autoLosses > 0 ? (autoWins / (autoWins + autoLosses) * 100) : 0;
    const manualWinRate = manualWins + manualLosses > 0 ? (manualWins / (manualWins + manualLosses) * 100) : 0;

    return {
      reply: `### 📈 Performance & Dual P&L Statistics\n\n` +
        `| Metric | Total Overall | 🤖 Autonomous AI | 👤 Manual DEX |\n` +
        `| :--- | :--- | :--- | :--- |\n` +
        `| **Net P&L** | **${fmtPnl(stats.totalPnlUsd || stats.netPnlUsd || 0)}** | **${fmtPnl(autoPnlUsd)}** | **${fmtPnl(manualPnlUsd)}** |\n` +
        `| **Win Rate** | **${stats.winRate.toFixed(1)}%** | **${autoWinRate.toFixed(1)}%** | **${manualWinRate.toFixed(1)}%** |\n` +
        `| **Wins / Losses** | ${stats.wins}W / ${stats.losses}L | ${autoWins}W / ${autoLosses}L | ${manualWins}W / ${manualLosses}L |\n` +
        `| **Trades Executed** | ${stats.totalTrades || closed.length} | ${stats.closedTradesCount || 0} closed | ${stats.openTradesCount || 0} open |\n\n` +
        `- **Best All-Time Trade**: **${stats.bestTradePnl ? `+$${stats.bestTradePnl.toFixed(2)}` : '—'}**\n` +
        `- **Active Open Positions**: ${stats.openTradesCount || stats.openTrades || 0}\n` +
        `- **Shadow Arena Data Collection**: ${shadowStats?.totalVetoed || 0} vetoed traps recorded for counterfactual optimization.\n` +
        `- **Authoritative Database**: Embedded SQLite (\`/app/data/trades.db\`) synced live with Aptos on-chain fills.\n\n` +
        `💡 *Click any trade in the dashboard Trade History to open its full AI Strategy Intel modal.*`,
      timestamp: Date.now(),
    };
  }

  // ─── F. Strategy Guide & Institutional Presets ────────────────────────────
  if (/(?:strategy|strategies|how do you trade|rule|rules|how it works|sniper|studio|canvas|live strategy|fomo|turtle|scalper|explain the \d+ strategies|strategy guide)/i.test(lower)) {
    const activeStrategy = getActiveStrategy();
    const dirs = standaloneEngine.getDirectives();
    const allocMin = activeStrategy.layer5?.minAllocPct ?? 15;
    const allocMax = activeStrategy.layer5?.maxAllocPct ?? 25;

    return {
      reply: `### 🎯 Strategy Intelligence: Live Deployed & Strategy Studio\n\n` +
        `🟢 **Currently LIVE ACTIVE Strategy in Bot:**\n` +
        `**${activeStrategy.name}** [ID: \`${activeStrategy.id}\`, v${activeStrategy.version || '3.0.0'}]\n` +
        `*${activeStrategy.description}*\n\n` +
        `#### 📊 Live Strategy Telemetry & Parameters:\n` +
        `- **Macro Operating Mode**: \`${dirs.source}\` (${dirs.regime} regime)\n` +
        `- **Layer Execution Order**: ${activeStrategy.layerOrder.map((l: string) => `**L${l.replace('layer', '').replace(/_.*/, '')}**`).join(' ➔ ')}\n` +
        `- **Risk-to-Reward Target**: **1 : ${(activeStrategy.layer5?.minRiskRewardRatio ?? 2.0).toFixed(1)}**\n` +
        `- **Position Sizing**: **${allocMin}% to ${allocMax}%** of budget per trade at **${activeStrategy.layer5?.leverage ?? 5}x** leverage\n` +
        `- **Dual Take-Profit**: ${activeStrategy.layer5?.dualTakeProfit ? `**Enabled** (${((activeStrategy.layer5?.tp1CloseRatio ?? 0.5) * 100).toFixed(0)}% scale-out at TP1 + Breakeven SL + TP2 runner)` : 'Single TP'}\n` +
        `- **Pillar 1 Maker Routing**: ${activeStrategy.layer5?.enforcePostOnly ? '🟢 **Maker-First PostOnly Active (0% Taker Drag, 25s timeout)**' : '⚪ Standard Market'}\n` +
        `- **Stagnation Time-Stop**: **${activeStrategy.layer5?.stagnationTimeStopBars ?? 8} bars** auto-exit if momentum stalls\n` +
        `- **SMC Dealing Range**: ${activeStrategy.layer3?.premiumDiscountEquilibrium ? 'Strict 50% Equilibrium (No Long in Premium / Short in Discount)' : 'Momentum expansion allowed'}\n\n` +
        `#### 📚 Institutional Strategy Presets in Studio:\n` +
        `1. ⚡ **Turtle Soup & Liquidity Grab** [template_turtle_soup] · Est. 74% WR\n` +
        `2. 🎯 **MTF Trend Pullback Sniper** [template_trend_sniper] · Est. 68% WR\n` +
        `3. 💥 **Funding Squeeze & Cascade Hunter** [template_squeeze_hunter] · Est. 64% WR\n` +
        `4. ⚖️ **Mean-Reversion Equilibrium Scalper** [template_range_scalper] · Est. 60% WR\n` +
        `5. 🚀 **FOMO Velocity & Hit-and-Run Scalper** [template_fomo_scalper] · Est. 62% WR\n` +
        `6. 🌊 **Macro Shock & Absorption Hunter** [template_macro_hunter] · Est. 71% WR\n` +
        `7. 🛡️ **Defensive Capital Shield Scalper** [template_capital_shield] · Est. 76% WR\n` +
        `8. 🏹 **Dynamic Confluence Multi-Layer Sniper** [template_confluence_sniper] · Est. 72% WR\n\n` +
        `#### 🛠️ Modular Quant Builder Canvas:\n` +
        `You can switch strategies anytime or build your own custom strategy directly in the **🧩 Strategy Studio** tab! Rearrange layers via drag-and-drop, toggle specific rules, tune sliders, run the **🤖 AI Quantitative Strategy Auditor**, and click **🚀 Deploy to Live Trading** to switch the bot's live brain instantly.`,
      timestamp: Date.now(),
    };
  }

  // ─── G. AI Trap Shield & Shockwave Cool-Off ────────────────────────────────
  if (/(?:trap shield|ai shield|trap validator|fake breakout|veto trade|conviction booster|qwen shield|traps|shockwave|circuit breaker|cool off|cool-off|panic freeze)/i.test(lower)) {
    const activeStrat = getActiveStrategy();
    const dirs = standaloneEngine.getDirectives();
    const activeGate = dirs.scoreFloor || 75;
    const shieldArmThreshold = Math.max(50, activeGate - 5);
    const vetoCrush = Math.max(35, activeGate - 15);
    const activeCoolOffs = riskGuard.getAllActiveCoolOffs();

    let text = `### 🛡️ Layer 4 AI Trap Shield & Shockwave Circuit Breaker\n\n`;
    text += `An adversarial defense layer that interrogates candidate setups before execution to prevent bull traps, bear traps, order book spoofing, and liquidity sweeps.\n\n`;
    text += `#### ⚙️ Current Dynamic Thresholds:\n`;
    text += `- **Active Strategy Base Gate:** **${activeGate}%** (*${activeStrat.name}*)\n`;
    text += `- **Dynamic Arming Threshold:** **${shieldArmThreshold}%+** (Triggers $\\text{Gate} - 5\\%$ to interrogate setups before execution)\n`;
    text += `- **Veto Penalty:** Confidence dynamically crushed to **${vetoCrush}%** on trap detection, vetoing entry\n`;
    text += `- **Status:** **ARMED (${shieldArmThreshold}%+)** · ${activeCoolOffs.length} active cool-off lock(s)\n\n`;

    text += `#### 🛡️ Live Shield Radar & Active Cool-Offs:\n`;
    if (activeCoolOffs.length > 0) {
      for (const c of activeCoolOffs) {
        text += `- 🚨 **${c.symbol}**: Banned Side: \`${c.action}\` — ⏱️ **${c.remainingMinutes}m remaining** (*${c.reason}*)\n`;
      }
    } else {
      text += `🟢 *Zero traps currently active. All 28 scanned pairs are undergoing continuous adversarial validation.*\n`;
    }

    text += `\n#### 🔬 What the Shield Interrogates:\n`;
    text += `1. **Order Book Spoofing:** Detects fleeting thick walls that vanish upon price approach.\n`;
    text += `2. **Wick Manipulation (Turtle Soup):** Rejection wicks >${dirs.bullTrapUpperWickPct}% that lack structural continuation.\n`;
    text += `3. **CVD / Delta OI Divergence:** Checks whether aggressive buyers/sellers are trapped.\n`;
    text += `4. **Microstructure Exhaustion:** Prevents long entries at extreme premium or short entries at extreme discount.\n`;

    return { reply: text, timestamp: Date.now() };
  }

  // ─── H. Portfolio Harvester ───────────────────────────────────────────────
  if (/(?:harvest|harvester|master harvest|portfolio harvest|lock profit|selective profit|take profit)/i.test(lower)) {
    const hState = portfolioHarvester.evaluate();
    const cfg = portfolioHarvester.getConfig();
    const open = tradeExecutor.getOpenTrades();

    let text = `### 🌾 Master Portfolio Profit Harvester (Client V3)\n\n`;
    text += `An institutional-grade risk engine that monitors aggregate portfolio Net P&L in real-time and selectively harvests profits to USDC while letting healthy runners ride to full targets.\n\n`;

    const isHarvesting = hState.status === 'TRIGGER_READY' || hState.status === 'MONITORING';
    text += `- **Harvester Status:** **${isHarvesting ? '🟢 ACTIVE (Harvesting & Guarding)' : '🟢 ARMED (Standby)'}**\n`;
    text += `- **Execution Style:** \`${cfg.executionStyle}\` | Sync Mode: \`${cfg.syncMode}\`\n`;
    text += `- **Harvest Score Threshold:** **Score ≥ ${cfg.harvestScoreThreshold}/100**\n`;
    text += `- **Runner Score Threshold:** **Score < ${cfg.runnerScoreThreshold}/100**\n`;
    text += `- **Min Net Harvest ROI:** **+${cfg.minHarvestPct}%** ($${cfg.minHarvestUsd} min profit floor)\n`;
    text += `- **Breakeven Acceleration:** **${cfg.accelerateBreakevenR}R**\n`;
    text += `- **Open Positions Tracked:** **${open.length}**\n\n`;

    if (hState.positionsList && hState.positionsList.length > 0) {
      text += `#### 📂 Live Position Vulnerability Breakdown:\n`;
      for (const p of hState.positionsList) {
        const badge = p.recommendation === 'RUNNER' ? '🟢 RUNNER' : p.recommendation === 'HARVEST' ? '🌾 HARVEST WATCH' : '⚖️ HOLD';
        const factors = (p.factors && p.factors.length) ? p.factors.join(', ') : 'Healthy structure';
        text += `- **${p.symbol}**: Net ${p.netPnlUsd >= 0 ? '+' : ''}$${p.netPnlUsd.toFixed(2)} | **Risk: ${p.score}/100** [${badge}] — *${factors}*\n`;
      }
    } else {
      text += `📭 *No active positions currently tracked by the Harvester.*`;
    }

    return { reply: text, timestamp: Date.now() };
  }

  // ─── I. Sim Lab Central Command & Alpha Bundle ─────────────────────────────
  if (/(?:sim lab|pipeline|port 4000|alpha bundle|sim status|simulation|alpha lab|sim calibration|arena|shadow arena|tournament|challenger|champion|supercharge)/i.test(lower)) {
    const isConn = superchargeClient.isActive();
    const sUrl = superchargeClient.getServerUrl();
    const flags = superchargeClient.getFeatureFlags();
    const dirs = standaloneEngine.getDirectives();

    let text = `### 🔬 Port 4000 AI Simulation Lab & Alpha Ingestion Desk (Client V3)\n\n`;
    text += `Continuously synchronizes counterfactual simulation bundles and calibrated parameters computed by **Claude Sonnet & Gemini** running on Port 4000.\n\n`;
    text += `#### 📡 Pipeline Connection & Health:\n`;
    text += `- **Connection Status:** ${isConn ? '🟢 **AUTHENTICATED & SUPERCHARGED**' : '🟡 **PURE STANDALONE MODE (Using Safe Local Rules)**'}\n`;
    text += `- **Target Endpoint:** \`${sUrl}\`\n`;
    text += `- **Active Operating Mode:** \`${dirs.source}\`\n`;
    text += `- **Active Strategy:** **${dirs.activeStrategy}**\n`;
    text += `- **Macro Market Regime:** **${dirs.regime}**\n`;
    text += `- **Dynamic Score Floor:** **≥${dirs.scoreFloor}%**\n`;
    text += `- **Wick Trap Tolerance:** **${dirs.bullTrapUpperWickPct}%**\n`;
    text += `- **Directional Restrictions:** ${dirs.bannedSides && dirs.bannedSides.length > 0 ? `\`${dirs.bannedSides.join(', ')}\`` : 'None (All sides permitted)'}\n\n`;

    text += `#### 🎛️ Active Feature Toggles:\n`;
    text += `- Macro Regime Sync: ${flags.syncMacroRegime ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Dynamic Indicators Sync: ${flags.syncIndicators ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Directional Bans Sync: ${flags.syncDirectionalBans ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Pre-Trade Counterfactual Veto: ${flags.syncCounterfactual ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- 8s Telemetry Heartbeat: ${flags.syncTelemetry ? '✅ Enabled' : '❌ Disabled'}\n`;
    text += `- Remote Strategy Studio: ${flags.syncStrategyStudio ? '✅ Enabled' : '❌ Disabled'}\n\n`;

    text += `🛡️ **Financial Guardrail Invariant:** Port 4000 operates in an advisory role with **zero on-chain execution authority** and no access to private keys. Port 3000 applies hard financial clamps to every recommendation to protect real capital on Aptos mainnet.`;
    return { reply: text, timestamp: Date.now() };
  }

  // ─── J. Token-Specific Queries (e.g. SUI, BTC, ETH) ───────────────────────
  const knownTokens = [
    'SUI', 'BTC', 'ETH', 'SOL', 'APT', 'XRP', 'DOGE', 'BNB', 'LINK',
    'AVAX', 'NEAR', 'ADA', 'TRX', 'DOT', 'HYPE', 'PEPE', 'SHIB',
    'LTC', 'BCH', 'UNI', 'FET', 'TAO', 'RENDER', 'ARB', 'OP', 'INJ', 'SEI', 'TIA'
  ];
  const matchedToken = knownTokens.find(t => 
    lower.includes(t.toLowerCase() + 'usd') || 
    lower.includes(t.toLowerCase() + '/usd') || 
    new RegExp(`\\b${t.toLowerCase()}\\b`).test(lower)
  );

  if (matchedToken) {
    const symNorm = `${matchedToken}/USD`;
    const m = agentState.markets?.[symNorm] || agentState.markets?.[`${matchedToken}-USD`] || Object.values(agentState.markets || {}).find(item => item.symbol.includes(matchedToken));
    const openTrades = tradeExecutor.getOpenTrades();
    const pos = openTrades.find(p => p.symbol.toUpperCase().includes(matchedToken));
    const simDir = getSimPairDirective(symNorm);
    const activeStrat = getActiveStrategy();
    const dirs = standaloneEngine.getDirectives();
    const gate = simDir?.minConfidenceGate ?? dirs.scoreFloor ?? 75;
    const lev = simDir?.maxLeverage ?? 5;

    let text = `### 🪙 ${matchedToken} Asset Intelligence Report\n\n`;
    if (m) {
      const chg = m.change24h ? (m.change24h >= 0 ? `+${m.change24h.toFixed(2)}%` : `${m.change24h.toFixed(2)}%`) : '0.00%';
      text += `- **Mark Price:** **$${m.markPrice}** (${chg} 24h)\n`;
      text += `- **Trend & Action:** \`${m.trend}\` | Action: \`${m.action}\`\n`;
      text += `- **Current Confluence Score:** **${m.confidence}%** (Required Gate: **≥${gate}%**)\n`;
      text += `- **Risk Profile:** \`${m.riskLevel}\` | Max Leverage: **${lev}x**\n`;
      if (m.candlestick) {
        text += `- **Technical Indicators:** RSI: **${m.candlestick.rsi14 ? m.candlestick.rsi14.toFixed(1) : '50.0'}** | ADX: **${m.candlestick.adx14 ? m.candlestick.adx14.toFixed(1) : '20.0'}**\n`;
      }
    } else {
      text += `- **Status:** Monitored on 28-pair Aptos perpetual scan cycle.\n`;
    }

    if (pos) {
      text += `\n🟢 **Active Position in Portfolio:**\n`;
      text += `- **Direction:** ${pos.action} (${pos.leverage}x)\n`;
      text += `- **Entry Price:** $${Number(pos.entryPrice).toFixed(4)}\n`;
      text += `- **Margin Deployed:** $${Number(pos.allocatedUsd || 0).toFixed(2)}\n`;
      text += `- **Take Profit:** $${pos.takeProfit ? Number(pos.takeProfit).toFixed(4) : 'None'} | **Stop Loss:** $${pos.stopLoss ? Number(pos.stopLoss).toFixed(4) : 'None'}\n`;
    } else {
      text += `\n📭 **No open position currently held in ${matchedToken}.**\n`;
      if (m && m.confidence < gate) {
        text += `• The pair is currently scoring **${m.confidence}%**, which is **${gate - m.confidence}%** below our high-conviction gate (≥${gate}%). The agent is patiently waiting for liquidity sweep or FVG retest confluence.\n`;
      }
    }

    return { reply: text, timestamp: Date.now() };
  }

  // ─── 3. Conversational / Open-Ended Inquiries (Passed to AI Brain) ─────────
  try {
    let gasBalance = 0;
    let marginBalance = 0;
    try {
      const onChain = await tradeExecutor.fetchOnChainBalance();
      gasBalance = onChain?.aptBalance ?? 0;
      marginBalance = onChain?.balanceUsd ?? 0;
    } catch {}

    const response = await localAIBrain.chat(query, {
      clientName: config.CLIENT_NAME,
      clientId: config.CLIENT_ID,
      network: config.NETWORK,
      subaccount: config.DECIBEL_SUBACCOUNT_ADDRESS,
      signerAddress: tradeExecutor.getSignerAddress(),
      gasAptBalance: gasBalance,
      onChainBalanceUsd: marginBalance,
      stats: tradeExecutor.getStats(),
      openPositions: tradeExecutor.getOpenTrades(),
      recentTrades: tradeExecutor.getClosedTrades().slice(-10),
      budgetUsd: config.BUDGET_USD,
      maxLeverage: config.MAX_LEVERAGE,
      paperTrading: config.PAPER_TRADING,
      watchPairs: config.WATCH_PAIRS.split(',').map((s: string) => s.trim()),
      directives: standaloneEngine.getDirectives(),
      isSimLabConnected: superchargeClient.isActive(),
      simLabServerUrl: superchargeClient.getServerUrl(),
      activeAiProvider: config.ACTIVE_AI_PROVIDER,
      activeAiModel: config.GEMINI_MODEL,
      simPairDirectives: getSimPairDirectives(),
    });

    if (response && response.reply && response.reply.trim()) {
      return {
        reply: response.reply.trim(),
        actionTaken: response.actionTaken ? 'ai_action' : undefined,
        timestamp: Date.now(),
      };
    }
  } catch (err: any) {
    logger.warn(`Copilot AI brain chat error: ${err.message}`);
  }

  // ─── 4. Default Assistant Help ─────────────────────────────────────────────
  const currentStrat = getActiveStrategy();
  return {
    reply: `👋 **I am your Decibel Trading Agent Copilot (Client V3).**\n\n` +
      `Active Strategy: **${currentStrat ? currentStrat.name : 'Turtle Soup & Liquidity Grab'}** | ` +
      `Open Positions: **${tradeExecutor.getOpenTrades().length}**\n\n` +
      `Here are things you can ask me directly in this dashboard:\n` +
      `• *"Why no trades yet?"* — Deep-dive into dynamic safety gates and scanned pairs\n` +
      `• *"Show my budget and risk"* — Full capital breakdown and position sizing\n` +
      `• *"Show live market overview"* — Real-time prices, 24h changes, and scores across all 28 pairs\n` +
      `• *"Explain the 8 strategies"* — Full strategy guide and studio presets\n` +
      `• *"Do we have open positions?"* — Review active positions, entry, TP/SL, and harvester health\n` +
      `• *"What is our win rate and P&L?"* — Review verified SQLite performance metrics\n` +
      `• \`scan now\` — Trigger an instant market scan across all pairs\n` +
      `• \`pause\` / \`resume\` — Toggle autonomous execution mode\n` +
      `• \`set confidence 75\` — Adjust minimum confidence floor (50–100%)`,
    timestamp: Date.now(),
  };
}
