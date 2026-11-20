import axios from 'axios';
import { safeLogger } from '../utils/logger.js';

export interface PromptContext {
  groupName: string;
  cycleIndex: number;
  totalCycles: number;
  contributionSats: number;
  deadlineHoursRemaining?: number;
  recipientName: string;
  memberData?: Array<{
    name: string;
    state: string;
    missedCount: number;
  }>;
}

export class AIService {
  private apiKey: string;
  private provider: 'free' | 'gemini' | 'openai';

  constructor(apiKey?: string, provider?: 'free' | 'gemini' | 'openai') {
    this.apiKey = apiKey || process.env.AI_API_KEY || '';
    const envProvider = process.env.AI_PROVIDER as 'free' | 'gemini' | 'openai' | undefined;
    // Default to 'free' (zero API key required) unless specifically set to gemini or openai with a key
    if (this.apiKey && (envProvider === 'gemini' || envProvider === 'openai')) {
      this.provider = envProvider;
    } else {
      this.provider = 'free';
    }
  }

  /**
   * Generates empathetic, plain-language payment reminder for members
   */
  async generatePaymentReminder(
    memberName: string,
    amountSats: number,
    hoursRemaining: number,
    beneficiaryName: string
  ): Promise<string> {
    const prompt = `
System: You are an encouraging, community-oriented financial assistant for an informal rotating savings group (Chama/Sacco).
Write a polite, warm, and clear reminder to a group member about their upcoming savings contribution.
Avoid crypto/technical jargon (don't say "mempool", "hash", "node"). Speak in friendly plain language.

Context:
- Member Name: ${memberName}
- Contribution: ${amountSats.toLocaleString()} sats
- Time Remaining: ${hoursRemaining > 0 ? `${hoursRemaining} hours` : 'overdue / grace period'}
- Payout Beneficiary this cycle: ${beneficiaryName}

Requirements:
- 2 to 3 sentences maximum.
- Remind them that paying on time helps ${beneficiaryName} receive their round on schedule.
- Keep it encouraging and direct.
`.trim();

    return this.callLLM(prompt, `Hey ${memberName}! Just a gentle nudge that your ${amountSats.toLocaleString()} sats contribution for this round is due. ${beneficiaryName} is up to receive the pot next, and your prompt payment helps the circle stay strong!`);
  }

  /**
   * Generates a human-readable cycle summary/ledger for the Telegram group
   */
  async generateCycleSummary(
    groupName: string,
    cycleIndex: number,
    potSats: number,
    beneficiaryName: string,
    paidMembers: string[],
    lateMembers: string[],
    missedMembers: string[]
  ): Promise<string> {
    const prompt = `
System: You are a friendly community treasurer summarizing the results of a rotating savings cycle (Chama/Sacco).
Generate a concise, positive, and transparent summary for the Telegram group.

Context:
- Group: ${groupName}
- Cycle: ${cycleIndex}
- Total Pot Disbursed: ${potSats.toLocaleString()} sats
- Winner / Recipient: ${beneficiaryName}
- Paid On Time: ${paidMembers.join(', ') || 'None'}
- Paid in Grace Window: ${lateMembers.join(', ') || 'None'}
- Missed / Incomplete: ${missedMembers.join(', ') || 'None'}

Requirements:
- Friendly celebration of ${beneficiaryName} receiving their pot!
- Transparent tally of participation.
- Clear mention of when the next cycle commences.
- Format with clean emojis and markdown bullet points.
`.trim();

    const fallback = `
🎉 **Cycle ${cycleIndex} Payout Complete!**

Congratulations to **${beneficiaryName}** who received the full pot of **${potSats.toLocaleString()} sats**!

📊 **Round Summary:**
• On-time contributors: ${paidMembers.length}
• Late contributions: ${lateMembers.length}
• Pending/Missed: ${missedMembers.length}

Thank you everyone for keeping the circle moving. Next cycle opens shortly!
`.trim();

    return this.callLLM(prompt, fallback);
  }

  /**
   * Analyzes group participation and flags risk anomalies
   */
  async flagAnomalies(
    groupName: string,
    memberHistories: Array<{ name: string; missedCycles: number; lateCycles: number; totalCycles: number }>
  ): Promise<{ hasAnomaly: boolean; analysis: string }> {
    const troubledMembers = memberHistories.filter(m => m.missedCycles > 0 || m.lateCycles >= 2);
    if (troubledMembers.length === 0) {
      return {
        hasAnomaly: false,
        analysis: 'All members maintain flawless contribution records. Circle health: Excellent.',
      };
    }

    const prompt = `
System: You are an objective risk analyst for a peer-to-peer micro-finance circle.
Analyze the following participant anomaly report and provide a brief recommendation to the group coordinator.

Group: ${groupName}
Flagged Members:
${troubledMembers.map(m => `- ${m.name}: ${m.missedCycles} missed cycles, ${m.lateCycles} late cycles out of ${m.totalCycles} total`).join('\n')}

Task:
Provide 2 concise sentences assessing circle risk and recommending proactive steps (e.g., check in privately before next round).
`.trim();

    const fallback = `Warning: ${troubledMembers.map(m => m.name).join(', ')} had late or missed payments. We recommend reaching out privately before next rotation.`;
    const analysis = await this.callLLM(prompt, fallback);

    return {
      hasAnomaly: true,
      analysis,
    };
  }

  private async callLLM(prompt: string, fallback: string): Promise<string> {
    try {
      if (this.provider === 'free') {
        // Free zero-setup AI endpoint: Pollinations.ai (OpenAI/Mistral backend)
        const res = await axios.post(
          'https://text.pollinations.ai/',
          {
            messages: [{ role: 'user', content: prompt }],
            model: 'openai',
            seed: 42,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        return text.trim() || fallback;
      }

      if (!this.apiKey) {
        return fallback;
      }

      if (this.provider === 'openai') {
        const res = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 300,
            temperature: 0.7,
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 12000,
          }
        );
        return res.data.choices[0].message.content.trim();
      } else {
        // Gemini API
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.apiKey}`;
        const res = await axios.post(
          url,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 12000,
          }
        );
        return res.data.candidates[0].content.parts[0].text.trim();
      }
    } catch (err: unknown) {
      safeLogger.warn('AI API call failed, using graceful fallback', { error: (err as Error).message });
      return fallback;
    }
  }
}
