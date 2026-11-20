# 🎬 Sats Sacco — 3-Minute Demo Video Script

**Target Duration:** 3:00  
**Characters:** Voiceover / Presenter (enthusiastic, practical Bitcoin engineer)  
**Visual Style:** Screen capture of Telegram Bot interaction side-by-side with the Companion Web Dashboard and Nostr Relay explorer.

---

### [0:00 - 0:40] Problem: The Fragility of Paper Chamas & Susus
**[VISUAL: Split screen — on the left, photo of a paper notebook with handwritten crossed-out numbers; on the right, Sats Sacco logo.]**

**VOICEOVER:**
> "Over 1 billion people worldwide rely on informal rotating savings circles — known as Chamas in Kenya, Susus in Ghana, Tandas in Latin America, and Chit Funds in India.
> 
> They pool money every week, and each round, one member takes home the lump sum to buy stock, pay school fees, or expand a workshop.
> 
> But today, these circles depend on paper notebooks and human cash collectors. Invoices get lost, coordinators walk away with the treasury, and worse — when a member pays on time for 10 straight years, that financial discipline counts for *zero* in the formal banking world. They have no credit score."

---

### [0:40 - 1:20] Solution: Sats Sacco on Lightning + Nostr
**[VISUAL: Sats Sacco companion dashboard opens, showing a high-contrast circular rotation wheel and live satoshi counter.]**

**VOICEOVER:**
> "Enter **Sats Sacco** — autonomous, non-custodial savings circles coordinated over Telegram, settled instantly via Bitcoin Lightning, and attested immutably on Nostr.
> 
> Here’s how it works:
> 1. A coordinator creates a group in Telegram with fixed dues — say, 5,000 sats every 24 hours.
> 2. The circle locks the rotation sequence with a cryptographic unique constraint. Collision is mathematically impossible.
> 3. Each cycle, members receive individual Bolt11 Lightning invoices.
> 4. The moment the final contribution arrives, the full pot is automatically disbursed directly to that round's beneficiary. The bot never holds custodial risk."

---

### [1:20 - 2:15] Live Demo: Atomic Payout & Verifiable Nostr Reputation
**[VISUAL: Screen recording shows Telegram bot `/newgroup` interaction, paying a testnet invoice, and dashboard dynamically updating to 15,000 sats.]**

**VOICEOVER:**
> "Let’s watch a live round in action:
> 
> When our member 'Mama Mboga' is up to receive the pot, the engine generates an LNURL payout. Notice what happens if a network hiccup occurs — our atomic mutex lock prevents double-payout races.
> 
> And what about members who fall behind? Our integrated AI assistant detects when an invoice expires, generating empathetic, culturally-aware reminders in plain language — no technical mempool jargon.
> 
> But the real superpower is **Nostr reputation**. Every on-time payment, late grace payment, or cycle completion publishes a signed Kind 30078 attestation tied to the member's public key across public relays like `nos.lol` and `damus`.
> 
> Even if our server vanishes tomorrow, their 100% on-time track record lives permanently on Nostr."

---

### [2:15 - 3:00] Impact & Next Steps
**[VISUAL: Architecture diagram highlighting merchant integrations and portable credit scoring.]**

**VOICEOVER:**
> "By turning traditional peer trust into cryptographic proof, Sats Sacco brings unbanked merchants into the global financial fold.
> 
> **What we're building next:**
> - Portable DeFi credit scoring derived directly from Nostr reputation proofs.
> - Multi-currency Cashu eCash escrow for members with offline intermittent connectivity.
> - Direct merchant point-of-sale integrations.
> 
> Sats Sacco: Building community wealth, sat by sat, without middlemen. Thank you!"

