import { randomBytes } from "node:crypto";

export interface PairingTicket {
  token: string;
  expiresAt: number;
}

export class PairingStore {
  private ticket: PairingTicket | null = null;

  issue(now = Date.now(), ttlMs = 5 * 60_000) {
    this.ticket = {
      token: randomBytes(24).toString("base64url"),
      expiresAt: now + ttlMs,
    };
    return this.ticket;
  }

  accepts(token: string, now = Date.now()) {
    return Boolean(this.ticket && this.ticket.token === token && now <= this.ticket.expiresAt);
  }
}
