/**
 * Client Status CLI Tool
 * 
 * Displays the current status of the client agent, open positions,
 * win rate, PnL, and active directives.
 */

import { config, getDerivedSignerAddress } from '../src/config';
import { tradeExecutor } from '../src/trades/executor';
import { standaloneEngine } from '../src/engine/standalone-engine';

function runStatus(): void {
  const stats = tradeExecutor.getStats();
  const openTrades = tradeExecutor.getOpenTrades();
  const directives = standaloneEngine.getDirectives();
  const signer = getDerivedSignerAddress();

  console.log('\n================================================================================');
  console.log('                    DECIBEL TRADING CLIENT — SYSTEM STATUS                       ');
  console.log('================================================================================');
  console.log(`  Client Name:        ${config.CLIENT_NAME}`);
  console.log(`  Operating Mode:     ${config.OPERATING_MODE} (${directives.source})`);
  console.log(`  Paper Trading:      ${config.PAPER_TRADING ? 'ON (Simulation)' : 'OFF (Real On-Chain Orders)'}`);
  console.log(`  AI Brain Provider:  ${config.ACTIVE_AI_PROVIDER.toUpperCase()}`);
  console.log(`  Network:            ${config.NETWORK.toUpperCase()}`);
  console.log(`  Subaccount:         ${config.DECIBEL_SUBACCOUNT_ADDRESS || 'None'}`);
  console.log(`  Signer Gas Key:     ${signer ? signer + ' (Option B Non-Custodial)' : 'None'}`);
  console.log('--------------------------------------------------------------------------------');
  console.log('  FINANCIAL & POSITION METRICS:');
  console.log(`  Budget Total:       $${config.BUDGET_USD.toFixed(2)} USD`);
  console.log(`  Budget Deployed:    $${stats.budgetUsedUsd.toFixed(2)} USD`);
  console.log(`  Budget Available:   $${stats.budgetAvailableUsd.toFixed(2)} USD`);
  console.log(`  Realized PnL:       $${stats.totalPnlUsd.toFixed(2)} USD`);
  console.log(`  Win Rate:           ${stats.winRate}% (${stats.wins}W / ${stats.losses}L)`);
  console.log(`  Total Trades:       ${stats.totalTrades} (Open: ${stats.openTradesCount})`);
  console.log('--------------------------------------------------------------------------------');
  console.log('  ACTIVE STRATEGY DIRECTIVES:');
  console.log(`  Active Strategy:    ${directives.activeStrategy}`);
  console.log(`  Score Floor:        ${directives.scoreFloor}`);
  console.log(`  Wick Tolerance:     ${directives.bullTrapUpperWickPct}%`);
  console.log(`  Banned Sides:       [${directives.bannedSides.join(', ') || 'None'}]`);
  console.log(`  Market Regime:      ${directives.regime}`);
  console.log('--------------------------------------------------------------------------------');

  if (openTrades.length === 0) {
    console.log('  OPEN POSITIONS:     None (All capital safe in margin)');
  } else {
    console.log(`  OPEN POSITIONS (${openTrades.length}):`);
    for (const t of openTrades) {
      console.log(
        `   • [${t.symbol}] ${t.action} @ $${t.entryPrice} | TP: $${t.takeProfit} | ` +
        `SL: $${t.stopLoss} | Alloc: $${t.allocatedUsd} (${t.leverage}x) | ID: ${t.id}`,
      );
    }
  }

  console.log('================================================================================\n');
}

runStatus();
