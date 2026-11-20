import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const LOG_SALT = process.env.LOG_SALT || 'default_sats_sacco_salt_2026';

/**
 * Hash an identifier (Telegram user ID, username, or pubkey) for zero-PII logging.
 * Returns first 12 characters of SHA256 hex digest.
 */
export function hashIdentifier(id: string | number): string {
  return crypto
    .createHmac('sha256', LOG_SALT)
    .update(String(id))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Safe logger that strips raw IDs and sanitizes strings.
 */
export const safeLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, meta ? sanitizeMeta(meta) : '');
  },
  warn: (msg: string, meta?: Record<string, unknown>) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, meta ? sanitizeMeta(meta) : '');
  },
  error: (msg: string, error?: unknown, meta?: Record<string, unknown>) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, error, meta ? sanitizeMeta(meta) : '');
  },
};

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(meta)) {
    if (key.toLowerCase().includes('telegram_id') || key.toLowerCase().includes('tg_id') || key.toLowerCase().includes('userid')) {
      sanitized[`${key}_hash`] = hashIdentifier(String(val));
    } else if (key.toLowerCase().includes('key') || key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('macaroon')) {
      sanitized[key] = '[REDACTED]';
    } else if (key.toLowerCase().includes('pubkey') && typeof val === 'string') {
      sanitized[key] = `${val.slice(0, 8)}...${val.slice(-4)}`;
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

