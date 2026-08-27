import { randomBytes } from "node:crypto";

export interface PairingTicket {
  token: string;
  expiresAt: number;
  sessionToken?: string;
}

export interface PairingTicketOptions {
  now?: number;
  ttlMs?: number;
  sessionToken?: string;
}

export class PairingStore {
  private ticket: PairingTicket | null = null;

  issue({ now = Date.now(), ttlMs = 5 * 60_000, sessionToken }: PairingTicketOptions = {}) {
    this.ticket = {
      token: randomBytes(24).toString("base64url"),
      expiresAt: now + ttlMs,
      ...(sessionToken ? { sessionToken } : {}),
    };
    return this.ticket;
  }

  consume(token: string, now = Date.now()) {
    if (!this.ticket || this.ticket.token !== token || now > this.ticket.expiresAt) return null;
    const ticket = this.ticket;
    this.ticket = null;
    return ticket;
  }
}
