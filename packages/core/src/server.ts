import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaccoEngine } from './engine.js';
import { createDatabase } from './db.js';
import { LNbitsService } from './services/lnbits.js';
import { NostrService } from './services/nostr.js';
import { AIService } from './services/ai.js';
import { safeLogger } from './utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer(engine: SaccoEngine) {
  const server = Fastify({ logger: false });

  server.register(cors, { origin: '*' });
  server.register(websocket);

  // Serve Dashboard HTML
  const dashboardPath = path.resolve(__dirname, '../../../packages/dashboard');
  server.register(fastifyStatic, {
    root: dashboardPath,
    prefix: '/',
  });

  // Health check
  server.get('/api/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Get all groups
  server.get('/api/groups', async () => {
    return engine.db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all();
  });

  // Get specific group details with members and cycles
  server.get('/api/groups/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const group = engine.db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    if (!group) return reply.status(404).send({ error: 'Group not found' });

    const members = engine.db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY rotation_index ASC').all(id);
    const cycles = engine.db.prepare('SELECT * FROM cycles WHERE group_id = ? ORDER BY cycle_index DESC').all(id);

    return {
      group,
      members,
      cycles,
    };
  });

  // Get current cycle details with individual contribution statuses
  server.get('/api/cycles/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cycle = engine.db.prepare('SELECT * FROM cycles WHERE id = ?').get(id);
    if (!cycle) return reply.status(404).send({ error: 'Cycle not found' });

    const contributions = engine.db.prepare(`
      SELECT c.*, m.display_name, m.nostr_pubkey, m.lightning_address
      FROM contributions c
      JOIN members m ON c.member_id = m.id
      WHERE c.cycle_id = ?
    `).all(id);

    return {
      cycle,
      contributions,
    };
  });

  // Webhook for LNbits payment receipt
  server.post('/api/webhook/lnbits', async (req, reply) => {
    const body = req.body as { payment_hash?: string; preimage?: string };
    if (!body?.payment_hash) {
      return reply.status(400).send({ error: 'Missing payment_hash' });
    }

    try {
      const preimage = body.preimage || 'confirmed_preimage';
      const updated = await engine.recordContributionPayment(body.payment_hash, preimage);
      return { success: true, contribution: updated };
    } catch (err: unknown) {
      safeLogger.error('Webhook error processing payment', { error: (err as Error).message });
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // Query verifiable member reputation from Nostr
  server.get('/api/reputation/:pubkey', async (req) => {
    const { pubkey } = req.params as { pubkey: string };
    const events = await engine.nostr.queryMemberReputation(pubkey);
    return {
      pubkey,
      events,
    };
  });

  return server;
}

if (process.env.NODE_ENV !== 'test' && !process.env.IS_SEED) {
  const db = createDatabase(process.env.DATABASE_PATH || './data/sats_sacco.db');
  const lnbits = new LNbitsService(
    process.env.LNBITS_BASE_URL || 'https://lnbits.eu',
    process.env.LNBITS_ADMIN_KEY || '4eaef53498b14f7ab0e2332fbb4dfbad',
    process.env.LNBITS_INVOICE_READ_KEY || '8193a9df5f1f494286a4fa9ca909fed7'
  );
  const relays = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol').split(',');
  const nostr = new NostrService(relays, process.env.NOSTR_PRIVATE_KEY_HEX);
  const ai = new AIService();
  const engine = new SaccoEngine(db, lnbits, nostr, ai);

  const server = createServer(engine);
  const port = parseInt(process.env.PORT || '3001', 10);
  server.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      safeLogger.error('Failed to start server', { error: err.message });
      process.exit(1);
    }
    safeLogger.info(`Sats Sacco Backend API running at ${address}`);
  });
}

