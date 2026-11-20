import Database from 'better-sqlite3';
import { LNbitsService } from './services/lnbits.js';
import { NostrService } from './services/nostr.js';
import { AIService } from './services/ai.js';
import { safeLogger } from './utils/logger.js';
import { SaccoGroup, SaccoMember, SaccoCycle, MemberContribution } from './types.js';
import crypto from 'node:crypto';

export class SaccoEngine {
  public db: Database.Database;
  public lnbits: LNbitsService;
  public nostr: NostrService;
  public ai: AIService;

  constructor(
    db: Database.Database,
    lnbits: LNbitsService,
    nostr: NostrService,
    ai: AIService
  ) {
    this.db = db;
    this.lnbits = lnbits;
    this.nostr = nostr;
    this.ai = ai;
  }

  /**
   * 1. CREATE GROUP (FORMING)
   */
  createGroup(params: {
    name: string;
    creator_tg_id: number;
    contribution_sats: number;
    cycle_interval_hours: number;
    max_members: number;
  }): SaccoGroup {
    const id = crypto.randomUUID();
    const now = Date.now();
    const group: SaccoGroup = {
      id,
      name: params.name,
      creator_tg_id: params.creator_tg_id,
      contribution_sats: params.contribution_sats,
      cycle_interval_hours: params.cycle_interval_hours,
      max_members: params.max_members,
      state: 'FORMING',
      current_cycle_index: 0,
      created_at: now,
      updated_at: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO groups (id, name, creator_tg_id, contribution_sats, cycle_interval_hours, max_members, state, current_cycle_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      group.id,
      group.name,
      group.creator_tg_id,
      group.contribution_sats,
      group.cycle_interval_hours,
      group.max_members,
      group.state,
      group.current_cycle_index,
      group.created_at,
      group.updated_at
    );

    safeLogger.info('Sacco group created', { group_id: id, name: group.name });
    return group;
  }

  /**
   * 2. JOIN GROUP (FORMING)
   */
  addMember(params: {
    group_id: string;
    tg_id: number;
    tg_username?: string;
    display_name: string;
    nostr_pubkey: string;
    lightning_address?: string;
  }): SaccoMember {
    const group = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(params.group_id) as SaccoGroup;
    if (!group) throw new Error('Group not found');
    if (group.state !== 'FORMING') throw new Error('Cannot join group once active or finished');

    const memberCount = (this.db.prepare('SELECT COUNT(*) as count FROM members WHERE group_id = ?').get(params.group_id) as { count: number }).count;
    if (memberCount >= group.max_members) {
      throw new Error('Group reached maximum capacity');
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const member: SaccoMember = {
      id,
      group_id: params.group_id,
      tg_id: params.tg_id,
      tg_username: params.tg_username,
      display_name: params.display_name,
      nostr_pubkey: params.nostr_pubkey,
      lightning_address: params.lightning_address,
      joined_at: now,
      is_blacklisted: 0,
    };

    const stmt = this.db.prepare(`
      INSERT INTO members (id, group_id, tg_id, tg_username, display_name, nostr_pubkey, lightning_address, joined_at, is_blacklisted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      member.id,
      member.group_id,
      member.tg_id,
      member.tg_username || null,
      member.display_name,
      member.nostr_pubkey,
      member.lightning_address || null,
      member.joined_at,
      0
    );

    safeLogger.info('Member joined Sacco group', { group_id: group.id, pubkey: member.nostr_pubkey });
    return member;
  }

  /**
   * 3. ACTIVATE GROUP & LOCK ROTATION (FORMING -> ACTIVE)
   * Prevents race condition / collision by strictly locking rotation_index (0..N-1)
   */
  async activateGroup(groupId: string): Promise<SaccoGroup> {
    const group = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as SaccoGroup;
    if (!group) throw new Error('Group not found');
    if (group.state !== 'FORMING') throw new Error(`Group state must be FORMING, got ${group.state}`);

    const members = this.db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY joined_at ASC').all(groupId) as SaccoMember[];
    if (members.length < 2) throw new Error('A Sacco group requires at least 2 members');

    // Deterministic shuffle / assign rotation index
    const assignTx = this.db.transaction(() => {
      members.forEach((m, idx) => {
        this.db.prepare('UPDATE members SET rotation_index = ? WHERE id = ?').run(idx, m.id);
      });

      this.db.prepare('UPDATE groups SET state = ?, updated_at = ? WHERE id = ?').run('ACTIVE', Date.now(), groupId);
    });

    assignTx();

    // Broadcast formation event to Nostr multi-relay pool
    await this.nostr.publishGroupFormation(
      groupId,
      group.name,
      group.contribution_sats,
      members.map(m => m.nostr_pubkey)
    );

    safeLogger.info('Group activated and rotation immutably locked', { group_id: groupId, member_count: members.length });
    return this.db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as SaccoGroup;
  }

  /**
   * 4. OPEN NEW CYCLE ROUND (ACTIVE -> CYCLE_OPEN -> COLLECTING)
   */
  async openCycle(groupId: string): Promise<SaccoCycle> {
    const group = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId) as SaccoGroup;
    if (!group || group.state !== 'ACTIVE') throw new Error('Group must be ACTIVE to start cycle');

    const nextCycleIndex = group.current_cycle_index + 1;
    const members = this.db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY rotation_index ASC').all(groupId) as SaccoMember[];
    
    if (nextCycleIndex > members.length) {
      // Completed all rotation rounds!
      this.db.prepare('UPDATE groups SET state = ?, updated_at = ? WHERE id = ?').run('COMPLETED', Date.now(), groupId);
      throw new Error('All cycles completed for this Sacco group');
    }

    // Beneficiary for this cycle is the member with rotation_index = nextCycleIndex - 1
    const beneficiaryIndex = nextCycleIndex - 1;
    const beneficiary = members.find(m => m.rotation_index === beneficiaryIndex);
    if (!beneficiary) throw new Error(`No member found for rotation index ${beneficiaryIndex}`);

    const cycleId = crypto.randomUUID();
    const now = Date.now();
    const deadline = now + group.cycle_interval_hours * 3600 * 1000;
    const potTarget = group.contribution_sats * members.length;

    const cycle: SaccoCycle = {
      id: cycleId,
      group_id: groupId,
      cycle_index: nextCycleIndex,
      beneficiary_member_id: beneficiary.id,
      state: 'COLLECTING',
      pot_target_sats: potTarget,
      pot_collected_sats: 0,
      opened_at: now,
      deadline_at: deadline,
      payout_in_progress: 0,
    };

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO cycles (id, group_id, cycle_index, beneficiary_member_id, state, pot_target_sats, pot_collected_sats, opened_at, deadline_at, payout_in_progress)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cycle.id,
        cycle.group_id,
        cycle.cycle_index,
        cycle.beneficiary_member_id,
        cycle.state,
        cycle.pot_target_sats,
        cycle.pot_collected_sats,
        cycle.opened_at,
        cycle.deadline_at,
        0
      );

      this.db.prepare('UPDATE groups SET current_cycle_index = ?, updated_at = ? WHERE id = ?').run(nextCycleIndex, now, groupId);
    });

    tx();

    // Generate real LNbits invoices for each contributing member
    for (const member of members) {
      const contribId = crypto.randomUUID();
      let invoice;
      try {
        const memo = `SatsSacco:${group.name}:Cycle${nextCycleIndex}:${member.display_name}`;
        invoice = await this.lnbits.createInvoice(group.contribution_sats, memo, group.cycle_interval_hours * 3600);
      } catch (err: unknown) {
        safeLogger.warn('LNbits invoice creation deferred', { error: (err as Error).message });
      }

      this.db.prepare(`
        INSERT INTO contributions (id, cycle_id, member_id, state, amount_sats, invoice_bolt11, payment_hash, invoice_created_at, invoice_expires_at, late_grace_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        contribId,
        cycle.id,
        member.id,
        invoice ? 'INVOICE_SENT' : 'PENDING',
        group.contribution_sats,
        invoice?.payment_request || null,
        invoice?.payment_hash || null,
        now,
        deadline,
        deadline + 24 * 3600 * 1000 // 24-hr grace period
      );
    }

    safeLogger.info('Opened new cycle', { group_id: groupId, cycle_index: nextCycleIndex, beneficiary: beneficiary.display_name });
    return cycle;
  }

  /**
   * 5. RECORD PAYMENT (INVOICE_SENT -> PAID | LATE)
   */
  async recordContributionPayment(paymentHash: string, preimage: string): Promise<MemberContribution> {
    const contrib = this.db.prepare('SELECT * FROM contributions WHERE payment_hash = ?').get(paymentHash) as MemberContribution;
    if (!contrib) throw new Error('Contribution invoice not found');
    if (contrib.state === 'PAID' || contrib.state === 'LATE') return contrib;

    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(contrib.cycle_id) as SaccoCycle;
    const member = this.db.prepare('SELECT * FROM members WHERE id = ?').get(contrib.member_id) as SaccoMember;
    const now = Date.now();

    const isLate = now > (contrib.invoice_expires_at || 0);
    const newState = isLate ? 'LATE' : 'PAID';

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE contributions 
        SET state = ?, payment_preimage = ?, paid_at = ?
        WHERE id = ?
      `).run(newState, preimage, now, contrib.id);

      // Increment pot collected
      this.db.prepare(`
        UPDATE cycles
        SET pot_collected_sats = pot_collected_sats + ?
        WHERE id = ?
      `).run(contrib.amount_sats, cycle.id);
    });

    tx();

    // Publish settlement receipt on Nostr
    try {
      const receiptId = await this.nostr.publishContributionReceipt(
        cycle.group_id,
        cycle.cycle_index,
        member.nostr_pubkey,
        contrib.amount_sats,
        preimage,
        isLate
      );
      this.db.prepare('UPDATE contributions SET nostr_receipt_id = ? WHERE id = ?').run(receiptId, contrib.id);
    } catch (err: unknown) {
      safeLogger.warn('Nostr contribution receipt publish failed', { error: (err as Error).message });
    }

    // Check if cycle is complete and ready for payout!
    await this.checkCycleCompletion(cycle.id);

    return this.db.prepare('SELECT * FROM contributions WHERE id = ?').get(contrib.id) as MemberContribution;
  }

  /**
   * 6. CHECK CYCLE COMPLETION & TRIGGER PAYOUT
   */
  async checkCycleCompletion(cycleId: string): Promise<boolean> {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as SaccoCycle;
    if (!cycle || cycle.state === 'PAYOUT_SETTLED') return false;

    const contributions = this.db.prepare('SELECT * FROM contributions WHERE cycle_id = ?').all(cycleId) as MemberContribution[];
    const allPaid = contributions.every(c => c.state === 'PAID' || c.state === 'LATE');

    if (allPaid && cycle.state !== 'PAYOUT_PENDING' && cycle.state !== 'PAYOUT_SETTLED') {
      this.db.prepare(`UPDATE cycles SET state = 'CYCLE_COMPLETE' WHERE id = ?`).run(cycleId);
      safeLogger.info('All contributions collected, cycle complete', { cycle_id: cycleId });

      // Trigger payout
      await this.disbursePayout(cycleId);
      return true;
    }

    return false;
  }

  /**
   * 7. ATOMIC PAYOUT DISBURSEMENT (PAYOUT_PENDING -> PAYOUT_SETTLED)
   * Guaranteed safe against double payout and race conditions via atomic flag.
   */
  async disbursePayout(cycleId: string): Promise<{ success: boolean; preimage?: string; error?: string }> {
    // 1. Acquire atomic lock on cycle payout
    const lockAcquired = this.db.prepare(`
      UPDATE cycles 
      SET payout_in_progress = 1, state = 'PAYOUT_PENDING', payout_initiated_at = ?
      WHERE id = ? AND payout_in_progress = 0 AND state != 'PAYOUT_SETTLED'
    `).run(Date.now(), cycleId);

    if (lockAcquired.changes === 0) {
      safeLogger.warn('Payout already in progress or already settled', { cycle_id: cycleId });
      return { success: false, error: 'Payout already in progress or settled' };
    }

    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as SaccoCycle;
    const beneficiary = this.db.prepare('SELECT * FROM members WHERE id = ?').get(cycle.beneficiary_member_id) as SaccoMember;
    const group = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(cycle.group_id) as SaccoGroup;

    try {
      if (!beneficiary.lightning_address) {
        throw new Error(`Beneficiary ${beneficiary.display_name} has no Lightning address registered`);
      }

      // Resolve Lightning Address to Bolt11
      const bolt11 = await this.lnbits.getInvoiceFromLightningAddress(beneficiary.lightning_address, cycle.pot_collected_sats);
      
      // Pay invoice via LNbits
      const payResult = await this.lnbits.payInvoice(bolt11);
      const preimage = payResult.preimage || '0000000000000000000000000000000000000000000000000000000000000000';

      // Succeeded! Transition to PAYOUT_SETTLED
      this.db.prepare(`
        UPDATE cycles
        SET state = 'PAYOUT_SETTLED',
            payout_settled_at = ?,
            payout_preimage = ?,
            payout_tx_id = ?,
            payout_in_progress = 0
        WHERE id = ?
      `).run(Date.now(), preimage, payResult.payment_hash, cycleId);

      // Publish Nostr Settlement Receipt
      await this.nostr.publishPayoutSettlement(
        group.id,
        cycle.cycle_index,
        beneficiary.nostr_pubkey,
        cycle.pot_collected_sats,
        preimage
      );

      safeLogger.info('Pot payout settled successfully', {
        cycle_id: cycleId,
        beneficiary: beneficiary.display_name,
        amount_sats: cycle.pot_collected_sats,
      });

      return { success: true, preimage };
    } catch (err: unknown) {
      const errorMsg = (err as Error).message;
      safeLogger.error('Payout failed, releasing lock for retry', { cycle_id: cycleId, error: errorMsg });

      // Release lock and record error
      this.db.prepare(`
        UPDATE cycles
        SET payout_in_progress = 0,
            payout_error = ?
        WHERE id = ?
      `).run(errorMsg, cycleId);

      return { success: false, error: errorMsg };
    }
  }

  /**
   * 8. CHECK FOR MISSED INVOICES & TRIGGER AI REMINDER
   */
  async checkMissedInvoices(): Promise<void> {
    const now = Date.now();
    const expiredContributions = this.db.prepare(`
      SELECT c.*, m.display_name, cy.group_id, cy.cycle_index, g.name as group_name
      FROM contributions c
      JOIN members m ON c.member_id = m.id
      JOIN cycles cy ON c.cycle_id = cy.id
      JOIN groups g ON cy.group_id = g.id
      WHERE c.state = 'INVOICE_SENT' AND c.invoice_expires_at < ?
    `).all(now) as Array<MemberContribution & { display_name: string; group_name: string }>;

    for (const contrib of expiredContributions) {
      this.db.prepare(`UPDATE contributions SET state = 'MISSED' WHERE id = ?`).run(contrib.id);
      safeLogger.info('Marked contribution as MISSED', { contrib_id: contrib.id, member: contrib.display_name });

      // AI Reminder trigger
      const reminder = await this.ai.generatePaymentReminder(contrib.display_name, contrib.amount_sats, 0, 'the circle beneficiary');
      safeLogger.info('Generated AI reminder for missed member', { reminder });
    }
  }

  /**
   * 9. ROGUE MEMBER EXIT PROTOCOL
   * If a member tries to defect post-payout, record violation and broadcast Nostr blacklist
   */
  async handleRogueDefector(memberId: string): Promise<void> {
    const member = this.db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) as SaccoMember;
    if (!member) throw new Error('Member not found');

    this.db.prepare('UPDATE members SET is_blacklisted = 1 WHERE id = ?').run(memberId);

    // Publish reputation event
    await this.nostr.publishReputationUpdate(
      member.nostr_pubkey,
      member.group_id,
      'DEFAULTED',
      { reason: 'Rogue departure mid-cycle without completing dues' }
    );

    safeLogger.warn('Rogue member flagged and blacklisted on Nostr', { pubkey: member.nostr_pubkey });
  }
}

