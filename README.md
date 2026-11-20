# Sats Sacco — AI-Assisted Group Savings Circles on Lightning + Nostr

[![Tests](https://img.shields.io/badge/tests-6%20passed-brightgreen.svg)]()
[![Bitcoin Lightning](https://img.shields.io/badge/lightning-LNbits-orange.svg)]()
[![Nostr Protocol](https://img.shields.io/badge/nostr-NIP--78-purple.svg)]()
[![Telegram Bot](https://img.shields.io/badge/bot-grammY-blue.svg)]()

---

## 1. Problem $\to$ Solution $\to$ Impact

### The Problem
Over 1 billion people worldwide rely on informal **Rotating Savings and Credit Associations (ROSCAs)** — known as *Chamas* (East Africa), *Susus* (West Africa), *Tandas* (Latin America), and *Chit Funds* (India). Members pool funds each cycle and rotate receiving the lump sum to finance inventory, equipment, or emergency needs. 

However, existing informal systems suffer from critical flaws:
- **Custodial Risk & Theft**: Human treasurers frequently abscond or mismanage pooled cash.
- **Lost Accountability**: Paper notebooks lead to disputes over missed or late payments.
- **Zero Financial Mobility**: A member who faithfully contributes for 5 years builds **zero verifiable credit score** in the formal financial system.

### The Solution: Sats Sacco
**Sats Sacco** provides an autonomous, transparent digital infrastructure for informal savings groups:
- **Instant Lightning Settlement**: Invoices generated and paid via LNbits; pot disbursed immediately to each round's winner without long-term bot custody.
- **Verifiable Portable Reputation on Nostr**: Every on-time contribution, late payment, and completed circle is published as a signed Nostr attestation (Kind 30078) to public relays (`nos.lol`, `damus.io`), creating a sovereign credit identity.
- **AI Community Assistant**: Evaluates cycle health, flags anomalies, and generates warm, jargon-free payment reminders.
- **Companion Dashboard**: High-contrast, tactile circular rotation visualizer for low-end mobile devices and slow connections.

### The Impact
Unbanked merchants and community members convert paper-based social trust into **cryptographic, decentralized financial reputation** that can be leveraged across borders without relying on legacy credit bureaus.

---

## 2. Architecture & Data Flow

```
                      +-----------------------------+
                      |   Telegram Group / Bot      |
                      |  (@SatsSaccoBot - grammY)   |
                      +--------------+--------------+
                                     |
                                     v
+------------------------------------+------------------------------------+
|                         Sats Sacco Core Engine                         |
|                                                                         |
|  [Group Lifecycle]         [Cycle Rotation]        [Member Tracking]    |
|   FORMING -> ACTIVE         Atomic Mutex Lock       PENDING -> PAID     |
|                                                                         |
|  [SQLite ACID Storage]   [AI Assistant Engine]    [Zero-PII Logger]     |
|   WAL mode + Constraints  Reminders & Ledgers      Salted SHA256 hashes |
+---------+--------------------------+--------------------------+---------+
          |                          |                          |
          v                          v                          v
+--------------------+     +--------------------+     +--------------------+
|   LNbits Backend   |     | Nostr Multi-Relay  |     | Companion Web View |
| (Bolt11 Invoices & |     | (Kind 30078 Proofs |     | (Tailwind / Static |
|  LNURL-Pay Payouts)|     |  & Reputations)    |     |  Circular Wheel)   |
+--------------------+     +--------------------+     +--------------------+
```

---

## 3. Quick Start & Setup

### Prerequisites
- Node.js $\ge 20$ (v22 recommended)
- `pnpm` $\ge 9$
- Docker & Docker Compose (optional, for containerized run)

### Local Development Setup

1. **Clone the repository and install dependencies**:
   ```bash
   pnpm install
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Fill in your:
   - `TELEGRAM_BOT_TOKEN`: From `@BotFather`
   - `LNBITS_BASE_URL`: URL to your LNbits instance (e.g. `https://legend.lnbits.com` or local docker)
   - `LNBITS_ADMIN_KEY`: Admin API key from your LNbits wallet
   - `AI_API_KEY`: Gemini API key (or OpenAI API key)

3. **Run Seed Script (Creates Real Demo Group & Verifies Relays)**:
   ```bash
   pnpm seed
   ```

4. **Run Automated Test Suite (State Machine & Race Conditions)**:
   ```bash
   pnpm test
   ```

5. **Start Core API Server & Companion Web Dashboard**:
   ```bash
   pnpm dev:server
   ```
   Open `http://localhost:3001` in your browser to view the companion web dashboard!

6. **Start Telegram Bot**:
   ```bash
   pnpm dev:bot
   ```

---

## 4. One-Command Docker Setup

To launch both the Sats Sacco backend server/dashboard and the Telegram bot in isolated containers:
```bash
docker compose up -d --build
```

---

## 5. Automated Test Suite Output

All state machine transitions, edge cases, and the forced atomic payout race condition are covered under `tests/engine.test.ts`:

```
 ✓ tests/engine.test.ts (6 tests)
   ✓ Sats Sacco — Multi-Tier State Machine & Edge Cases
     ✓ 1. Transition FORMING -> ACTIVE and assigns unique collision-free rotation
     ✓ 2. Invoices generated on cycle start & all members pay timely -> PAYOUT_SETTLED
     ✓ 3. Member invoice expires before payment -> marks MISSED, preserves cycle accounting
     ✓ 4. Member pays late during grace period -> marked LATE, pot still accumulates
     ✓ 5. Forced Payout Race Condition: concurrent calls must be atomic and idempotent
     ✓ 6. Rogue member defection flags reputation & blacklists member

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

---

## 6. Threat Model & Security Architecture

1. **Zero PII Logging**:
   - Telegram user IDs and usernames are never stored in plaintext application logs.
   - All identifiers are transformed into salted SHA-256 HMAC fingerprints: `user_hash: SHA256(tg_id + SALT)[:12]`.
   - API keys, lightning preimages, and secrets are strictly redacted in log streams.

2. **Non-Custodial / Minimal Custody Design**:
   - The bot does not hold long-term custody of funds.
   - When a cycle is full, the pot is immediately disbursed to the beneficiary's registered Lightning address (`lnurlp`).
   - Invoices are per-member, per-cycle.

3. **Compromised Account Mitigation**:
   - Payout addresses are fixed at group activation; updating a payout address requires coordinator re-authentication.

4. **Adversarial Relays & Untrusted Payloads**:
   - External Nostr events and Webhook payloads are parsed and validated strictly against UUID and invoice hash patterns.
   - Nostr events are cryptographically finalized with Schnorr signatures (BIP-340).

---

## 7. Known Limitations

In strict adherence to the project standards:
1. **LNbits Demo Server SSL Alert**: Public shared demo instances (like `legend.lnbits.com`) occasionally reject rapid API bursts with TLS alerts under heavy load. A dedicated self-hosted LNbits instance or local Docker container is recommended for production deployment.
2. **Nostr Relay Connectivity Latency**: Public test relays (`damus.io`, `nos.lol`) can periodically exhibit latency during pool synchronization. The engine employs timeout guards to prevent blocking local database transitions.

---

## 8. What We'll Build Next (Roadmap)

- [ ] **Credit Scoring Engine**: Machine learning model translating signed Nostr reputation events into credit risk tiers for micro-lenders.
- [ ] **Cashu eCash Escrow Buffering**: Offline eCash fallback for members in areas with zero cell connectivity during cycle deadlines.
- [ ] **Multi-Group Collateral Pools**: Ability for high-reputation members to vouch for newcomers via staked sats.
- [ ] **Merchant POS Integration**: Allow local vendors to contribute dues automatically as a percentage of daily Lightning point-of-sale receipts.

