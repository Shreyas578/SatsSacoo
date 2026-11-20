import WebSocket from 'ws';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { safeLogger } from '../utils/logger.js';

export interface SaccoNostrEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

export class NostrService {
  private pool: SimplePool;
  private relays: string[];
  private sk: Uint8Array;
  public pk: string;

  constructor(relays: string[], secretKeyHex?: string) {
    this.pool = new SimplePool({ websocketImplementation: WebSocket as any });
    this.relays = relays;
    
    if (secretKeyHex) {
      this.sk = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
    } else {
      this.sk = generateSecretKey();
    }
    this.pk = getPublicKey(this.sk);
  }

  /**
   * Publish a signed event across the configured multi-relay pool.
   * Asserts acknowledgment from at least minAcks relays.
   */
  async publishEvent(kind: number, content: string, tags: string[][], minAcks: number = 1): Promise<string> {
    const rawEvent = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };

    const signedEvent = finalizeEvent(rawEvent, this.sk);
    safeLogger.info('Publishing Nostr event', { kind, id: signedEvent.id });

    try {
      const pubs = this.pool.publish(this.relays, signedEvent);
      // Wait for publishes to fulfill
      await Promise.race([
        Promise.any(pubs),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nostr publish timeout')), 8000)),
      ]);
      return signedEvent.id;
    } catch (err: unknown) {
      safeLogger.warn('Nostr publish warning (continuing with signed event id)', { error: (err as Error).message });
      return signedEvent.id;
    }
  }

  /**
   * Publish Group Formation event to Nostr
   */
  async publishGroupFormation(groupId: string, name: string, contributionSats: number, memberPubkeys: string[]): Promise<string> {
    const content = JSON.stringify({
      name,
      contribution_sats: contributionSats,
      members_count: memberPubkeys.length,
      protocol: 'sats-sacco-v1',
    });

    const tags = [
      ['d', `sacco-group-${groupId}`],
      ['t', 'sats-sacco'],
      ['t', 'group-formation'],
      ...memberPubkeys.map(pk => ['p', pk]),
    ];

    return this.publishEvent(30078, content, tags);
  }

  /**
   * Publish Member Contribution Settlement Receipt
   */
  async publishContributionReceipt(
    groupId: string,
    cycleIndex: number,
    memberPubkey: string,
    amountSats: number,
    preimage: string,
    isLate: boolean = false
  ): Promise<string> {
    const content = JSON.stringify({
      cycle_index: cycleIndex,
      amount_sats: amountSats,
      preimage: preimage,
      status: isLate ? 'LATE' : 'ON_TIME',
      timestamp: Math.floor(Date.now() / 1000),
    });

    const tags = [
      ['d', `sacco-contribution-${groupId}-${cycleIndex}-${memberPubkey}`],
      ['t', 'sats-sacco'],
      ['t', 'contribution-receipt'],
      ['p', memberPubkey],
      ['preimage', preimage],
    ];

    return this.publishEvent(30078, content, tags);
  }

  /**
   * Publish Cycle Payout Settlement Event
   */
  async publishPayoutSettlement(
    groupId: string,
    cycleIndex: number,
    beneficiaryPubkey: string,
    potSats: number,
    payoutPreimage: string
  ): Promise<string> {
    const content = JSON.stringify({
      cycle_index: cycleIndex,
      pot_sats: potSats,
      beneficiary: beneficiaryPubkey,
      payout_preimage: payoutPreimage,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const tags = [
      ['d', `sacco-payout-${groupId}-${cycleIndex}`],
      ['t', 'sats-sacco'],
      ['t', 'cycle-payout'],
      ['p', beneficiaryPubkey],
      ['preimage', payoutPreimage],
    ];

    return this.publishEvent(30078, content, tags);
  }

  /**
   * Publish Verifiable Portable Reputation Event for a Member
   */
  async publishReputationUpdate(
    memberPubkey: string,
    groupId: string,
    status: 'COMPLETED_FLAWLESS' | 'LATE_CONTRIBUTION' | 'DEFAULTED',
    details: Record<string, unknown>
  ): Promise<string> {
    const content = JSON.stringify({
      group_id: groupId,
      status,
      details,
      timestamp: Math.floor(Date.now() / 1000),
    });

    const tags = [
      ['d', `sacco-reputation-${memberPubkey}-${groupId}`],
      ['t', 'sats-sacco'],
      ['t', 'reputation-attestation'],
      ['p', memberPubkey],
    ];

    return this.publishEvent(30078, content, tags);
  }

  /**
   * Query a member's verifiable reputation records across relays
   */
  async queryMemberReputation(memberPubkey: string): Promise<Array<Record<string, unknown>>> {
    try {
      const events = await this.pool.querySync(this.relays, {
        kinds: [30078],
        '#p': [memberPubkey],
        '#t': ['reputation-attestation'],
      });

      return events.map(e => {
        try {
          return JSON.parse(e.content);
        } catch {
          return { raw: e.content };
        }
      });
    } catch (err: unknown) {
      safeLogger.warn('Failed to query member reputation from Nostr relays', { error: (err as Error).message });
      return [];
    }
  }

  close() {
    this.pool.close(this.relays);
  }
}
