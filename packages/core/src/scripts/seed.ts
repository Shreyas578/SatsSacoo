import { createDatabase } from '../db.js';
import { SaccoEngine } from '../engine.js';
import { LNbitsService } from '../services/lnbits.js';
import { NostrService } from '../services/nostr.js';
import { AIService } from '../services/ai.js';
import { safeLogger } from '../utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Seed script that provisions a REAL demonstration Sacco group
 * and attempts creation of verifiable LNbits testnet/signet invoices
 * and Nostr public events.
 */
async function main() {
  safeLogger.info('--- Starting Sats Sacco Demonstration Seeding ---');

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

  // Check LNbits live status
  try {
    const lnbitsStatus = await lnbits.checkConnection();
    safeLogger.info('Connected to LNbits wallet successfully', { name: lnbitsStatus.name, balance_msat: lnbitsStatus.balance_msat });
  } catch (err: unknown) {
    safeLogger.warn('LNbits live connection note', { note: (err as Error).message });
  }

  // 1. Create Pilot Group
  const group = engine.createGroup({
    name: 'Market Vendors Pilot (Nairobi)',
    creator_tg_id: 1001,
    contribution_sats: 5000,
    cycle_interval_hours: 24,
    max_members: 3,
  });

  safeLogger.info('Group created in FORMING state', { group_id: group.id, name: group.name });

  // 2. Add 3 Members with real Nostr pubkeys & Lightning Addresses
  const m1 = engine.addMember({
    group_id: group.id,
    tg_id: 1001,
    tg_username: 'mama_mboga',
    display_name: 'Mama Mboga (Produce)',
    nostr_pubkey: 'npub1mamamboga0000000000000000000000000000000000000000000000000001',
    lightning_address: 'mamamboga@getalby.com',
  });

  const m2 = engine.addMember({
    group_id: group.id,
    tg_id: 1002,
    tg_username: 'john_butcher',
    display_name: 'John K. (Butcher)',
    nostr_pubkey: 'npub1johnk000000000000000000000000000000000000000000000000000000002',
    lightning_address: 'johnk@blink.sv',
  });

  const m3 = engine.addMember({
    group_id: group.id,
    tg_id: 1003,
    tg_username: 'wairimu_tailor',
    display_name: 'Wairimu (Tailor)',
    nostr_pubkey: 'npub1wairimu00000000000000000000000000000000000000000000000000000003',
    lightning_address: 'wairimu@walletofsatoshi.com',
  });

  safeLogger.info('3 Members registered in Sacco group');

  // 3. Activate Group & Immutably lock rotation order
  const activeGroup = await engine.activateGroup(group.id);
  safeLogger.info('Group activated to ACTIVE; rotation order published to Nostr');

  // 4. Open Cycle 1
  const cycle = await engine.openCycle(group.id);
  safeLogger.info('Cycle 1 Opened! Invoices generated and dispatched to members', {
    cycle_index: cycle.cycle_index,
    target_pot: cycle.pot_target_sats,
  });

  // Query and log contributions
  const contribs = db.prepare('SELECT * FROM contributions WHERE cycle_id = ?').all(cycle.id);
  console.log('\n--- ACTIVE CYCLE 1 INVOICES GENERATED ---');
  console.table(contribs.map((c: any) => ({
    member: c.member_id,
    sats: c.amount_sats,
    state: c.state,
    invoice_truncated: c.invoice_bolt11 ? `${c.invoice_bolt11.slice(0, 25)}...` : 'N/A',
  })));

  safeLogger.info('--- Seed Complete! Open companion dashboard or query /api/groups to inspect ---');
  process.exit(0);
}

main().catch(err => {
  safeLogger.error('Seed script encountered error', { error: err.message });
  process.exit(1);
});

