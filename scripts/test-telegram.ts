/**
 * Telegram Notification Verification CLI Tool
 * 
 * Tests the Telegram Bot Token and Chat ID configured in .env or data/settings.json,
 * and sends a real-time test notification to verify delivery.
 */

import { telegramNotifier } from '../src/notify/telegram';

async function runTest(): Promise<void> {
  console.log('\n================================================================================');
  console.log('              DECIBEL TRADING CLIENT — TELEGRAM ALERT TEST                       ');
  console.log('================================================================================\n');

  // Allow passing token and chat id directly via CLI:
  // npm run test:telegram [botToken] [chatId]
  const cliToken = process.argv[2];
  const cliChatId = process.argv[3];

  if (cliToken && cliChatId) {
    console.log(`📝 Updating settings with provided CLI arguments...`);
    telegramNotifier.updateSettings(cliToken, cliChatId, true);
  }

  const settings = telegramNotifier.getSettings();
  console.log(`Current Configuration:`);
  console.log(`   - Bot Token: ${settings.botToken || 'Not Configured'}`);
  console.log(`   - Chat ID:   ${settings.chatId || 'Not Configured'}`);
  console.log(`   - Enabled:   ${settings.enabled ? 'YES' : 'NO'}\n`);

  if (!settings.enabled) {
    console.log('⚠️  Telegram alerts are currently disabled or missing credentials.');
    console.log('   Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your .env or run:');
    console.log('   npx ts-node scripts/test-telegram.ts <YOUR_BOT_TOKEN> <YOUR_CHAT_ID>\n');
    process.exit(1);
  }

  console.log('📡 Sending test notification to Telegram...');
  const result = await telegramNotifier.sendTestMessage();

  if (result.success) {
    console.log('\n🎉 SUCCESS! Real-time test notification delivered to your Telegram!\n');
    process.exit(0);
  } else {
    console.error(`\n❌ Failed to send Telegram message: ${result.error}\n`);
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
