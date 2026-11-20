import axios, { AxiosInstance } from 'axios';
import { safeLogger } from '../utils/logger.js';

export interface LNbitsInvoiceResponse {
  payment_hash: string;
  payment_request: string;
  checking_id: string;
  lnurl_response?: unknown;
}

export interface LNbitsPaymentStatus {
  paid: boolean;
  preimage?: string;
  details?: Record<string, unknown>;
}

export interface LNbitsPayResponse {
  payment_hash: string;
  checking_id: string;
  fee_msat?: number;
  preimage?: string;
}

export class LNbitsService {
  private client: AxiosInstance;
  private adminKey: string;
  private invoiceReadKey: string;

  constructor(baseURL: string, adminKey: string, invoiceReadKey?: string) {
    this.adminKey = adminKey;
    this.invoiceReadKey = invoiceReadKey || adminKey;
    this.client = axios.create({
      baseURL: baseURL.replace(/\/$/, ''),
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Health check / wallet balance check against real LNbits instance
   */
  async checkConnection(): Promise<{ name: string; balance_msat: number }> {
    try {
      const res = await this.client.get('/api/v1/wallet', {
        headers: { 'X-Api-Key': this.invoiceReadKey },
      });
      return {
        name: res.data.name || 'LNbits Wallet',
        balance_msat: res.data.balance || 0,
      };
    } catch (err: unknown) {
      const errorMsg = (err as Error).message;
      safeLogger.error('LNbits connection failed', { errorMsg });
      throw new Error(`Cannot connect to LNbits: ${errorMsg}`);
    }
  }

  /**
   * Create a real Bolt11 invoice for a member's cycle contribution
   */
  async createInvoice(amountSats: number, memo: string, expirySecs: number = 3600): Promise<LNbitsInvoiceResponse> {
    try {
      const res = await this.client.post(
        '/api/v1/payments',
        {
          out: false,
          amount: amountSats,
          memo: memo,
          expiry: expirySecs,
        },
        {
          headers: { 'X-Api-Key': this.invoiceReadKey },
        }
      );
      return res.data;
    } catch (err: unknown) {
      safeLogger.error('LNbits invoice creation failed', { error: (err as Error).message });
      throw new Error(`LNbits invoice creation failed: ${(err as Error).message}`);
    }
  }

  /**
   * Poll payment status of an invoice by checking_id or payment_hash
   */
  async checkInvoiceStatus(paymentHash: string): Promise<LNbitsPaymentStatus> {
    try {
      const res = await this.client.get(`/api/v1/payments/${paymentHash}`, {
        headers: { 'X-Api-Key': this.invoiceReadKey },
      });
      return {
        paid: Boolean(res.data.paid),
        preimage: res.data.preimage || res.data.details?.preimage,
        details: res.data.details,
      };
    } catch (err: unknown) {
      safeLogger.error('LNbits check invoice failed', { paymentHash, error: (err as Error).message });
      throw new Error(`LNbits check invoice failed: ${(err as Error).message}`);
    }
  }

  /**
   * Pay a bolt11 invoice (e.g. for cycle pot payout to beneficiary)
   */
  async payInvoice(bolt11: string): Promise<LNbitsPayResponse> {
    try {
      const res = await this.client.post(
        '/api/v1/payments',
        {
          out: true,
          bolt11: bolt11,
        },
        {
          headers: { 'X-Api-Key': this.adminKey },
        }
      );
      return res.data;
    } catch (err: unknown) {
      safeLogger.error('LNbits pay invoice failed', { error: (err as Error).message });
      throw new Error(`LNbits pay invoice failed: ${(err as Error).message}`);
    }
  }

  /**
   * Resolve Lightning Address to invoice (LNURL-pay)
   */
  async getInvoiceFromLightningAddress(lnAddress: string, amountSats: number): Promise<string> {
    const parts = lnAddress.split('@');
    if (parts.length !== 2) {
      throw new Error(`Invalid Lightning address: ${lnAddress}`);
    }
    const [name, domain] = parts;
    const url = `https://${domain}/.well-known/lnurlp/${name}`;
    
    try {
      const metaRes = await axios.get(url, { timeout: 10000 });
      const callback = metaRes.data.callback;
      const minSendable = (metaRes.data.minSendable || 1000) / 1000;
      const maxSendable = (metaRes.data.maxSendable || 1000000000) / 1000;

      if (amountSats < minSendable || amountSats > maxSendable) {
        throw new Error(`Amount ${amountSats} sats outside range [${minSendable}, ${maxSendable}] for ${lnAddress}`);
      }

      const amountMsats = amountSats * 1000;
      const payRes = await axios.get(`${callback}?amount=${amountMsats}`, { timeout: 10000 });
      if (!payRes.data.pr) {
        throw new Error('LNURL callback returned no payment request');
      }
      return payRes.data.pr;
    } catch (err: unknown) {
      throw new Error(`Failed to resolve Lightning Address ${lnAddress}: ${(err as Error).message}`);
    }
  }
}
