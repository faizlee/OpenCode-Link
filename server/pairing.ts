import { randomBytes } from "node:crypto";

export interface PairingTicket {
  token: string;
  expiresAt: number;
  kind: "pairing" | "migration";
  sessionToken?: string;
}

export interface PairingTicketOptions {
  now?: number;
  ttlMs?: number;
  sessionToken?: string;
  kind?: "pairing" | "migration";
}

export class PairingStore {
  private readonly tickets = new Map<string, PairingTicket>();

  issue({ now = Date.now(), ttlMs = 5 * 60_000, sessionToken, kind = "pairing" }: PairingTicketOptions = {}) {
    for (const [token, ticket] of this.tickets) {
      if (now > ticket.expiresAt) this.tickets.delete(token);
    }
    if (kind === "pairing") {
      for (const [token, ticket] of this.tickets) {
        if (ticket.kind === "pairing") this.tickets.delete(token);
      }
    }
    const ticket = {
      token: randomBytes(24).toString("base64url"),
      expiresAt: now + ttlMs,
      kind,
      ...(sessionToken ? { sessionToken } : {}),
    };
    this.tickets.set(ticket.token, ticket);
    return ticket;
  }

  consume(token: string, now = Date.now()) {
    const ticket = this.tickets.get(token);
    if (!ticket || now > ticket.expiresAt) {
      if (ticket) this.tickets.delete(token);
      return null;
    }
    this.tickets.delete(token);
    return ticket;
  }
}
