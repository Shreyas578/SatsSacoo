import dotenv from 'dotenv';
import { createDatabase } from '../../core/src/db.js';
import { LNbitsService } from '../../core/src/services/lnbits.js';
import { NostrService } from '../../core/src/services/nostr.js';
import { AIService } from '../../core/src/services/ai.js';
import { SaccoEngine } from '../../core/src/engine.js';
import { createTelegramBot } from './bot.js';
import { safeLogger } from '../../core/src/utils/logger.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token || token.includes('YOUR_TELEGRAM_BOT_TOKEN')) {
  safeLogger.warn('No valid TELEGRAM_BOT_TOKEN found in environment. Please set it in .env to run the live Telegram bot.');
  process.exit(1);
}

const db = createDatabase(process.env.DATABASE_PATH || './data/sats_sacco.db');
const lnbits = new LNbitsService(
  process.env.LNBITS_BASE_URL || 'https://lnbits.eu',
  process.env.LNBITS_ADMIN_KEY || '4eaef53498b14f7ab0e2332fbb4dfbad',
  process.env.LNBITS_INVOICE_READ_KEY || '8193a9df5f1f494286a4fa9ca909fed7'
);
const relays = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net').split(',');
const nostr = new NostrService(relays, process.env.NOSTR_PRIVATE_KEY_HEX);
const ai = new AIService();
const engine = new SaccoEngine(db, lnbits, nostr, ai);

const bot = createTelegramBot(token, engine);

bot.start({
  onStart: (botInfo) => {
    safeLogger.info(`Sats Sacco Telegram Bot started as @${botInfo.username}`);
  },
});

