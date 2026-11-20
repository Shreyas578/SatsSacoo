import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../packages/core/src/db.js';
import { SaccoEngine } from '../packages/core/src/engine.js';
import { LNbitsService } from '../packages/core/src/services/lnbits.js';
import { NostrService } from '../packages/core/src/services/nostr.js';
import { AIService } from '../packages/core/src/services/ai.js';
import crypto from 'node:crypto';

describe('Sats Sacco — Multi-Tier State Machine & Edge Cases', () => {
  let db: ReturnType<typeof createDatabase>;
  let engine: SaccoEngine;
  let mockLNbits: LNbitsService;
  let mockNostr: NostrService;
  let mockAI: AIService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    
    // We instantiate services connected to the engine
    mockLNbits = new LNbitsService('http://127.0.0.1:5000', 'admin_key_test', 'read_key_test');
    // Stub the network calls for determinism in unit test suite
    mockLNbits.createInvoice = async (amount, memo) => ({
      payment_hash: crypto.randomBytes(32).toString('hex'),
      payment_request: `lnbc${amount}testinvoice`,
      checking_id: 'chk_' + crypto.randomUUID(),
    });
    mockLNbits.getInvoiceFromLightningAddress = async (addr, amt) => `lnbc${amt}payout_invoice`;
    mockLNbits.payInvoice = async (bolt11) => ({
      payment_hash: 'hash_payout_123',
      checking_id: 'chk_payout_123',
      preimage: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    });

    mockNostr = new NostrService(['wss://relay.damus.io']);
    mockNostr.publishEvent = async () => 'nostr_event_id_' + crypto.randomUUID();
    mockNostr.publishContributionReceipt = async () => 'receipt_id_' + crypto.randomUUID();
    mockNostr.publishPayoutSettlement = async () => 'payout_event_id_' + crypto.randomUUID();
    mockNostr.publishReputationUpdate = async () => 'rep_event_id_' + crypto.randomUUID();

    mockAI = new AIService();
    mockAI.generatePaymentReminder = async (m, a, h, b) => `Reminder: ${m}, ${a} sats due for ${b}.`;

    engine = new SaccoEngine(db, mockLNbits, mockNostr, mockAI);
  });

  it('1. Transition FORMING -> ACTIVE and assigns unique collision-free rotation', async () => {
    const group = engine.createGroup({
      name: 'Nairobi Market Vendors',
      creator_tg_id: 11111,
      contribution_sats: 10000,
      cycle_interval_hours: 24,
      max_members: 3,
    });

    expect(group.state).toBe('FORMING');

    const m1 = engine.addMember({
      group_id: group.id,
      tg_id: 11111,
      display_name: 'Alice',
      nostr_pubkey: 'npub1alice00000000000000000000000000000000000000000000000000000001',
      lightning_address: 'alice@getalby.com',
    });

    const m2 = engine.addMember({
      group_id: group.id,
      tg_id: 22222,
      display_name: 'Bob',
      nostr_pubkey: 'npub1bob0000000000000000000000000000000000000000000000000000000002',
      lightning_address: 'bob@getalby.com',
    });

    const m3 = engine.addMember({
      group_id: group.id,
      tg_id: 33333,
      display_name: 'Charlie',
      nostr_pubkey: 'npub1charlie000000000000000000000000000000000000000000000000000003',
      lightning_address: 'charlie@getalby.com',
    });

    const activeGroup = await engine.activateGroup(group.id);
    expect(activeGroup.state).toBe('ACTIVE');

    const members = db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY rotation_index ASC').all(group.id) as any[];
    expect(members.length).toBe(3);
    expect(members[0].rotation_index).toBe(0);
    expect(members[1].rotation_index).toBe(1);
    expect(members[2].rotation_index).toBe(2);

    // Verify DB UNIQUE constraint prevents duplicate rotation order
    expect(() => {
      db.prepare('UPDATE members SET rotation_index = 0 WHERE id = ?').run(members[1].id);
    }).toThrow();
  });

  it('2. Invoices generated on cycle start & all members pay timely -> PAYOUT_SETTLED', async () => {
    const group = engine.createGroup({
      name: 'Eldoret Farmers',
      creator_tg_id: 101,
      contribution_sats: 5000,
      cycle_interval_hours: 12,
      max_members: 2,
    });

    const m1 = engine.addMember({
      group_id: group.id,
      tg_id: 101,
      display_name: 'David',
      nostr_pubkey: 'npub1david00000000000000000000000000000000000000000000000000000001',
      lightning_address: 'david@blink.sv',
    });

    const m2 = engine.addMember({
      group_id: group.id,
      tg_id: 102,
      display_name: 'Grace',
      nostr_pubkey: 'npub1grace00000000000000000000000000000000000000000000000000000002',
      lightning_address: 'grace@blink.sv',
    });

    await engine.activateGroup(group.id);
    const cycle = await engine.openCycle(group.id);

    expect(cycle.state).toBe('COLLECTING');
    expect(cycle.beneficiary_member_id).toBe(m1.id); // rotation 0 is recipient in cycle 1

    const contribs = db.prepare('SELECT * FROM contributions WHERE cycle_id = ?').all(cycle.id) as any[];
    expect(contribs.length).toBe(2);
    expect(contribs[0].state).toBe('INVOICE_SENT');
    expect(contribs[1].state).toBe('INVOICE_SENT');

    // Settle both member invoices
    await engine.recordContributionPayment(contribs[0].payment_hash, 'preimage_1');
    await engine.recordContributionPayment(contribs[1].payment_hash, 'preimage_2');

    const updatedCycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(updatedCycle.state).toBe('PAYOUT_SETTLED');
    expect(updatedCycle.pot_collected_sats).toBe(10000);
    expect(updatedCycle.payout_preimage).toBeDefined();
  });

  it('3. Member invoice expires before payment -> marks MISSED, preserves cycle accounting', async () => {
    const group = engine.createGroup({
      name: 'Mombasa Traders',
      creator_tg_id: 501,
      contribution_sats: 2000,
      cycle_interval_hours: 1,
      max_members: 2,
    });

    engine.addMember({
      group_id: group.id,
      tg_id: 501,
      display_name: 'Amina',
      nostr_pubkey: 'npub1amina00000000000000000000000000000000000000000000000000000001',
      lightning_address: 'amina@ln.tips',
    });

    engine.addMember({
      group_id: group.id,
      tg_id: 502,
      display_name: 'Baraka',
      nostr_pubkey: 'npub1baraka0000000000000000000000000000000000000000000000000000002',
      lightning_address: 'baraka@ln.tips',
    });

    await engine.activateGroup(group.id);
    const cycle = await engine.openCycle(group.id);

    // Fast-forward invoice expiration
    db.prepare('UPDATE contributions SET invoice_expires_at = ? WHERE cycle_id = ?').run(Date.now() - 10000, cycle.id);

    await engine.checkMissedInvoices();

    const missed = db.prepare("SELECT * FROM contributions WHERE cycle_id = ? AND state = 'MISSED'").all(cycle.id);
    expect(missed.length).toBe(2);

    // Member remains in cycle records (not silently dropped)
    const all = db.prepare('SELECT * FROM contributions WHERE cycle_id = ?').all(cycle.id);
    expect(all.length).toBe(2);
  });

  it('4. Member pays late during grace period -> marked LATE, pot still accumulates', async () => {
    const group = engine.createGroup({
      name: 'Nakuru Collective',
      creator_tg_id: 601,
      contribution_sats: 3000,
      cycle_interval_hours: 1,
      max_members: 2,
    });

    engine.addMember({
      group_id: group.id,
      tg_id: 601,
      display_name: 'Sarah',
      nostr_pubkey: 'npub1sarah00000000000000000000000000000000000000000000000000000001',
      lightning_address: 'sarah@walletofsatoshi.com',
    });

    engine.addMember({
      group_id: group.id,
      tg_id: 602,
      display_name: 'Tariq',
      nostr_pubkey: 'npub1tariq00000000000000000000000000000000000000000000000000000002',
      lightning_address: 'tariq@walletofsatoshi.com',
    });

    await engine.activateGroup(group.id);
    const cycle = await engine.openCycle(group.id);

    const contribs = db.prepare('SELECT * FROM contributions WHERE cycle_id = ?').all(cycle.id) as any[];

    // Simulate Sarah paying on-time
    await engine.recordContributionPayment(contribs[0].payment_hash, 'preimage_sarah');

    // Simulate Tariq paying past invoice_expires_at
    db.prepare('UPDATE contributions SET invoice_expires_at = ? WHERE id = ?').run(Date.now() - 5000, contribs[1].id);
    const lateContrib = await engine.recordContributionPayment(contribs[1].payment_hash, 'preimage_tariq');

    expect(lateContrib.state).toBe('LATE');

    // Pot is still fully collected and triggers payout
    const updatedCycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(updatedCycle.pot_collected_sats).toBe(6000);
    expect(updatedCycle.state).toBe('PAYOUT_SETTLED');
  });

  it('5. Forced Payout Race Condition: concurrent calls must be atomic and idempotent', async () => {
    const group = engine.createGroup({
      name: 'Race Condition Test Sacco',
      creator_tg_id: 999,
      contribution_sats: 1000,
      cycle_interval_hours: 1,
      max_members: 2,
    });

    engine.addMember({
      group_id: group.id,
      tg_id: 999,
      display_name: 'Winner',
      nostr_pubkey: 'npub1winner0000000000000000000000000000000000000000000000000000001',
      lightning_address: 'winner@ln.tips',
    });

    engine.addMember({
      group_id: group.id,
      tg_id: 998,
      display_name: 'Payer',
      nostr_pubkey: 'npub1payer00000000000000000000000000000000000000000000000000000002',
      lightning_address: 'payer@ln.tips',
    });

    await engine.activateGroup(group.id);
    const cycle = await engine.openCycle(group.id);

    // Set collected sats
    db.prepare('UPDATE cycles SET pot_collected_sats = 2000 WHERE id = ?').run(cycle.id);

    // Concurrently trigger 2 payouts to test race condition
    const [res1, res2] = await Promise.all([
      engine.disbursePayout(cycle.id),
      engine.disbursePayout(cycle.id),
    ]);

    // One must succeed, the other must be rejected by atomic lock
    const successes = [res1.success, res2.success].filter(Boolean);
    const failures = [res1.success, res2.success].filter(s => !s);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    const finalCycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(finalCycle.state).toBe('PAYOUT_SETTLED');
    expect(finalCycle.payout_in_progress).toBe(0);
  });

  it('6. Rogue member defection flags reputation & blacklists member', async () => {
    const group = engine.createGroup({
      name: 'Trust Sacco',
      creator_tg_id: 701,
      contribution_sats: 5000,
      cycle_interval_hours: 24,
      max_members: 2,
    });

    const m1 = engine.addMember({
      group_id: group.id,
      tg_id: 701,
      display_name: 'RogueOne',
      nostr_pubkey: 'npub1rogue00000000000000000000000000000000000000000000000000000001',
      lightning_address: 'rogue@blink.sv',
    });

    await engine.handleRogueDefector(m1.id);

    const updated = db.prepare('SELECT * FROM members WHERE id = ?').get(m1.id) as any;
    expect(updated.is_blacklisted).toBe(1);
  });
});

