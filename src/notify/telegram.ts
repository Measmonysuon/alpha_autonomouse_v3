/**
 * Real-Time Telegram Notification Service
 * 
 * Delivers instant, beautifully formatted alerts directly to your phone:
 *  - 🚀 Trade Opened: Symbol, side, entry price, SL, TP, size, leverage, AI score
 *  - 🎯 Take Profit Hit: Realized profit, ROI %, exit price
 *  - 🛑 Stop Loss Hit: Realized loss, capital protected
 *  - ⚡ Sim Lab Status: Strategy updates, macro regimes, directional bans
 * 
 * Supports dynamic configuration via .env or Dashboard Settings API (data/settings.json).
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TradeRecord } from '../trades/executor';

export interface TelegramConfig {
  botToken: string;
  hasBotToken?: boolean;
  botTokenMasked?: string;
  chatId: string;
  enabled: boolean;
}

const SETTINGS_FILE_PATH = path.resolve(process.cwd(), 'data/settings.json');

export class TelegramNotifier {
  private botToken = '';
  private chatId = '';
  private enabled = false;

  constructor() {
    this.loadSettings();
  }

  public loadSettings(): void {
    let savedToken = '';
    let savedChatId = '';
    let savedEnabled = true;

    // 1. Try reading from data/settings.json
    try {
      if (fs.existsSync(SETTINGS_FILE_PATH)) {
        const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.telegram) {
          savedToken = parsed.telegram.botToken || '';
          savedChatId = parsed.telegram.chatId || '';
          savedEnabled = parsed.telegram.enabled !== false;
        }
      }
    } catch {}

    // 2. Fall back to .env
    this.botToken = (savedToken || config.TELEGRAM_BOT_TOKEN || '').trim();
    this.chatId = (savedChatId || config.TELEGRAM_CHAT_ID || '').trim();
    this.enabled = Boolean(this.botToken && this.chatId && savedEnabled);

    if (this.enabled) {
      logger.info(`📱 [TELEGRAM] Real-time alerts ACTIVE for Chat ID: ${this.chatId}`);
    } else {
      logger.info('📱 [TELEGRAM] Alerts inactive (Bot Token & Chat ID can be configured in Settings).');
    }
  }

  public updateSettings(botToken?: string, chatId?: string, enabled = true): void {
    if (botToken !== undefined && botToken.trim() !== '') {
      this.botToken = botToken.trim();
      config.TELEGRAM_BOT_TOKEN = this.botToken;
    }
    if (chatId !== undefined && chatId !== null) {
      this.chatId = chatId.trim();
      config.TELEGRAM_CHAT_ID = this.chatId;
    }
    this.enabled = Boolean(this.botToken && this.chatId && enabled);

    // Save to data/settings.json
    try {
      const dir = path.dirname(SETTINGS_FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let current: any = {};
      if (fs.existsSync(SETTINGS_FILE_PATH)) {
        try {
          current = JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8'));
        } catch {}
      }

      current.telegram = {
        botToken: this.botToken,
        chatId: this.chatId,
        enabled: this.enabled,
        updatedAt: Date.now(),
      };

      fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(current, null, 2), 'utf8');
      logger.info(`📱 [TELEGRAM] Settings updated! Enabled: ${this.enabled}`);
    } catch (err: any) {
      logger.error(`Failed to save Telegram settings: ${err.message}`);
    }
  }

  public getSettings(): TelegramConfig {
    return {
      botToken: this.botToken,
      hasBotToken: Boolean(this.botToken && this.botToken.trim() !== ''),
      botTokenMasked: this.botToken ? `${this.botToken.slice(0, 8)}...` : '',
      chatId: this.chatId,
      enabled: this.enabled,
    };
  }

  /**
   * Generic HTML message sender via Telegram Bot API
   */
  public async sendMessage(html: string): Promise<boolean> {
    if (!this.enabled || !this.botToken || !this.chatId) {
      return false;
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    try {
      await axios.post(
        url,
        {
          chat_id: this.chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 5000 },
      );
      return true;
    } catch (err: any) {
      const msg = err.response?.data?.description || err.message;
      logger.warn(`⚠️ [TELEGRAM] Failed to send notification: ${msg}`);
      return false;
    }
  }

  /**
   * Test notification sender to verify credentials
   */
  public async sendTestMessage(): Promise<{ success: boolean; error?: string }> {
    if (!this.botToken || !this.chatId) {
      return { success: false, error: 'Missing Telegram Bot Token or Chat ID' };
    }

    const html = `
<b>🔔 Telegram Real-Time Alerts Connected!</b>
━━━━━━━━━━━━━━━━━━
<b>Client:</b> <code>${config.CLIENT_NAME}</code>
<b>Mode:</b> <code>${config.OPERATING_MODE}</code>
<b>Network:</b> <code>${config.NETWORK.toUpperCase()}</code>
<b>Status:</b> Ready to receive live trade notifications!
`;

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      await axios.post(
        url,
        {
          chat_id: this.chatId,
          text: html,
          parse_mode: 'HTML',
        },
        { timeout: 5000 },
      );
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.description || err.message };
    }
  }

  // ── High-Level Event Notification Helpers ────────────────────────────────────

  public async notifyTradeOpened(trade: TradeRecord): Promise<void> {
    const isLong = trade.action === 'LONG';
    const sideIcon = isLong ? '🟢 <b>LONG</b>' : '🔴 <b>SHORT</b>';
    const paperTag = trade.isPaper ? ' <i>[PAPER SIMULATION]</i>' : ' <i>[LIVE MAINNET]</i>';

    const msg = `
🚀 <b>TRADE OPENED${paperTag}</b>
━━━━━━━━━━━━━━━━━━
<b>Pair:</b> <code>${trade.symbol}</code>
<b>Direction:</b> ${sideIcon} (${trade.leverage}x)
<b>Entry Price:</b> <code>$${trade.entryPrice}</code>
<b>Take Profit:</b> <code>$${trade.takeProfit.toFixed(4)}</code> (2.5x ATR)
<b>Stop Loss:</b> <code>$${trade.stopLoss.toFixed(4)}</code> (1.5x ATR)
<b>Allocated:</b> <code>$${trade.allocatedUsd.toFixed(2)} USD</code>
<b>Position Size:</b> <code>$${trade.sizeUsd.toFixed(2)} USD</code>
<b>Confidence:</b> <code>${trade.confidence}/100</code>
<b>Strategy:</b> <code>${trade.strategyName || 'Standalone'}</code>
`;
    await this.sendMessage(msg);
  }

  public async notifyTradeClosed(trade: TradeRecord): Promise<void> {
    const isWin = (trade.pnlUsd ?? 0) > 0;
    const headerIcon = isWin ? '🎯 <b>TAKE PROFIT HIT</b>' : '🛑 <b>STOP LOSS TRIGGERED</b>';
    const pnlSign = (trade.pnlUsd ?? 0) >= 0 ? '+' : '';
    const paperTag = trade.isPaper ? ' <i>[PAPER]</i>' : ' <i>[LIVE]</i>';

    const msg = `
${headerIcon}${paperTag}
━━━━━━━━━━━━━━━━━━
<b>Pair:</b> <code>${trade.symbol}</code> (${trade.action})
<b>Exit Price:</b> <code>$${trade.exitPrice?.toFixed(4) ?? 'N/A'}</code>
<b>Realized PnL:</b> <b>${pnlSign}$${trade.pnlUsd?.toFixed(2)} USD</b> (${pnlSign}${trade.pnlPct}%)
<b>Entry Price:</b> <code>$${trade.entryPrice}</code>
<b>Strategy:</b> <code>${trade.strategyName || 'Standalone'}</code>
`;
    await this.sendMessage(msg);
  }

  public async notifySimLabSupercharge(directives: any): Promise<void> {
    const banned = directives.bannedSides?.length > 0 ? `[${directives.bannedSides.join(', ')}]` : 'None';
    const msg = `
⚡ <b>SIM LAB SUPERCHARGED</b>
━━━━━━━━━━━━━━━━━━
<b>Active Strategy:</b> <code>${directives.activeStrategy}</code>
<b>Macro Regime:</b> <code>${directives.regime}</code>
<b>Score Floor:</b> <code>${directives.scoreFloor}</code>
<b>Wick Tolerance:</b> <code>${directives.bullTrapUpperWickPct}%</code>
<b>Directional Bans:</b> <b>${banned}</b>
`;
    await this.sendMessage(msg);
  }
  private isPolling = false;
  private lastUpdateId = 0;
  private pollingTimer: NodeJS.Timeout | null = null;
  private chatHandler?: (text: string, chatId: string) => Promise<string>;

  public setChatHandler(fn: (text: string, chatId: string) => Promise<string>): void {
    this.chatHandler = fn;
  }

  /**
   * Start 2-way Telegram polling loop for interactive commands & AI Copilot chat
   */
  public startPolling(): void {
    if (this.isPolling) return;
    if (!this.enabled || !this.botToken) {
      return;
    }

    this.isPolling = true;
    logger.info(`📱 [TELEGRAM BOT] Interactive 2-Way Chat polling STARTED for Desk: "${config.CLIENT_NAME}"`);

    const pollLoop = async () => {
      if (!this.isPolling || !this.botToken) return;

      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5`;
        const res = await axios.get(url, { timeout: 10000 });
        const updates = res.data?.result || [];

        for (const update of updates) {
          if (update.update_id >= this.lastUpdateId) {
            this.lastUpdateId = update.update_id;
          }

          const msg = update.message || update.channel_post;
          if (!msg || !msg.text) continue;

          const incomingChatId = String(msg.chat.id);
          const incomingText = msg.text.trim();

          // If no chatId was set yet, auto-pair with sender
          if (!this.chatId) {
            this.updateSettings(this.botToken, incomingChatId, true);
          }

          // Security check: only answer messages from the configured chat ID (or private DM)
          if (this.chatId && incomingChatId !== this.chatId) {
            continue;
          }

          await this.handleIncomingMessage(incomingText, incomingChatId);
        }
      } catch (err: any) {
        // Silent catch for network/timeout in polling loop
      }

      if (this.isPolling) {
        this.pollingTimer = setTimeout(pollLoop, 1500);
      }
    };

    pollLoop();
  }

  public stopPolling(): void {
    this.isPolling = false;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    logger.info('📱 [TELEGRAM BOT] Polling stopped.');
  }

  private async handleIncomingMessage(text: string, targetChatId: string): Promise<void> {
    const lower = text.toLowerCase();
    const clientName = config.CLIENT_NAME || 'Desk 02 (Mac Client v2)';

    // 1. Built-in fast command: /start or /help
    if (lower === '/start' || lower === '/help') {
      const helpHtml = `
🤖 <b>Decibel Trading Copilot — ${clientName}</b>
━━━━━━━━━━━━━━━━━━
I am your dedicated autonomous trading agent on Decibel DEX (Aptos Mainnet).

<b>Available Commands:</b>
• <code>/status</code> — Live desk state, mode, and gas balance
• <code>/positions</code> — Active open trades & real-time PnL
• <code>/pnl</code> — Win rate & total realized profit
• <code>/budget</code> — Deployed margin & available capital
• <code>/scan</code> — Trigger immediate 28-pair scan
• <code>/help</code> — Show this menu

💬 <i>You can also ask me anything directly! E.g. "What is our client name?", "Why no trades yet?", "How is SOL looking?", "Show risk settings".</i>
`;
      await this.sendCustomMessage(targetChatId, helpHtml);
      return;
    }

    // 2. Delegate to AI Copilot chat handler with complete internal client context
    if (this.chatHandler) {
      try {
        const reply = await this.chatHandler(text, targetChatId);
        if (reply) {
          // Format markdown reply into Telegram HTML
          const formatted = reply
            .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
            .replace(/\*(.*?)\*/g, '<i>$1</i>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
          await this.sendCustomMessage(targetChatId, formatted);
          return;
        }
      } catch (err: any) {
        logger.warn(`Failed to process Telegram message with Copilot: ${err.message}`);
      }
    }

    // Fallback response
    await this.sendCustomMessage(
      targetChatId,
      `🤖 <b>${clientName} Copilot:</b> Received <code>${text}</code>. Type <code>/help</code> for available commands.`,
    );
  }

  private async sendCustomMessage(targetChatId: string, html: string): Promise<boolean> {
    if (!this.botToken) return false;
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      await axios.post(
        url,
        {
          chat_id: targetChatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 5000 },
      );
      return true;
    } catch (err: any) {
      logger.warn(`⚠️ [TELEGRAM] Failed to send custom message: ${err.message}`);
      return false;
    }
  }

  public async sendPortfolioHarvest(...args: any[]): Promise<void> {
    // compatibility helper for legacy harvester
  }
}

export const telegramNotifier = new TelegramNotifier();

export function getTelegramNotifier(): TelegramNotifier {
  return telegramNotifier;
}

export function setTelegramNotifier(notifier: TelegramNotifier): void {
  // compatibility helper
}
