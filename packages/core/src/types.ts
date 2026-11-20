export type GroupState = 'FORMING' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'DISBANDED';

export type CycleState = 
  | 'CYCLE_OPEN' 
  | 'COLLECTING' 
  | 'CYCLE_COMPLETE' 
  | 'CYCLE_DEFAULTED' 
  | 'PAYOUT_PENDING' 
  | 'PAYOUT_SETTLED';

export type MemberCycleState = 'PENDING' | 'INVOICE_SENT' | 'PAID' | 'MISSED' | 'LATE' | 'DEFAULTED';

export interface SaccoGroup {
  id: string;
  name: string;
  creator_tg_id: number;
  contribution_sats: number;
  cycle_interval_hours: number;
  max_members: number;
  state: GroupState;
  current_cycle_index: number;
  created_at: number;
  updated_at: number;
}

export interface SaccoMember {
  id: string;
  group_id: string;
  tg_id: number;
  tg_username?: string;
  display_name: string;
  nostr_pubkey: string;
  lightning_address?: string; // or lnurlp / static payout address
  rotation_index?: number;     // 0..N-1 immutably set upon group activation
  joined_at: number;
  is_blacklisted?: number;     // 0 or 1
}

export interface SaccoCycle {
  id: string;
  group_id: string;
  cycle_index: number;
  beneficiary_member_id: string;
  state: CycleState;
  pot_target_sats: number;
  pot_collected_sats: number;
  opened_at: number;
  deadline_at: number;
  payout_initiated_at?: number;
  payout_settled_at?: number;
  payout_preimage?: string;
  payout_tx_id?: string;
  payout_error?: string;
  payout_in_progress: number; // 0 or 1 for atomic idempotency lock
}

export interface MemberContribution {
  id: string;
  cycle_id: string;
  member_id: string;
  state: MemberCycleState;
  amount_sats: number;
  invoice_bolt11?: string;
  payment_hash?: string;
  payment_preimage?: string;
  invoice_created_at?: number;
  invoice_expires_at?: number;
  paid_at?: number;
  late_grace_expires_at?: number;
  nostr_receipt_id?: string;
}

export interface MemberReputation {
  nostr_pubkey: string;
  total_cycles_completed: number;
  total_on_time: number;
  total_late: number;
  total_defaulted: number;
  groups_completed: number;
}

