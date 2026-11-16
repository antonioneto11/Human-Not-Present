import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only audit log (JSONL). Every state change of every payment is a new line,
 * so the full history of a purchase can be reconstructed and nothing is ever overwritten.
 */
export type LedgerStatus =
  | "denied" // policy refused
  | "declined" // human said no
  | "authorized" // signed and sent; outcome not yet known
  | "settled" // merchant confirmed on-chain settlement
  | "failed"; // sent but not settled

export interface LedgerEntry {
  ts: string;
  idempotencyKey: string;
  runId: string;
  status: LedgerStatus;
  url: string;
  merchant: string;
  reason: string; // the agent's stated reason for buying
  amountAtomic?: string;
  network?: string;
  payTo?: string;
  policy?: string; // policy decision explanation
  transaction?: string; // settlement reference: on-chain tx hash, or "sim_…" when simulated
  explorerUrl?: string; // only for real on-chain settlement
  simulated?: boolean; // true → settlement was simulated, no real funds moved
  delivery?: "passed" | "failed" | "unchecked"; // code-side delivery check on paid data
  deliveryNote?: string;
  error?: string;
}

export class Ledger {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: Omit<LedgerEntry, "ts">): LedgerEntry {
    const full = { ts: new Date().toISOString(), ...entry };
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    return full;
  }

  all(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  }

  /** Latest entry per idempotency key. */
  latestByKey(): Map<string, LedgerEntry> {
    const m = new Map<string, LedgerEntry>();
    for (const e of this.all()) m.set(e.idempotencyKey, e);
    return m;
  }

  find(idempotencyKey: string): LedgerEntry | undefined {
    return this.latestByKey().get(idempotencyKey);
  }

  /**
   * Spend counted against today's budget: settled payments plus anything still
   * "authorized" (in flight / unknown outcome). Counting in-flight spend is the
   * conservative choice — a crash mid-payment can't be used to exceed the budget.
   */
  spentTodayAtomic(now = new Date()): bigint {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let total = 0n;
    for (const e of this.latestByKey().values()) {
      if ((e.status === "settled" || e.status === "authorized") && e.amountAtomic && Date.parse(e.ts) >= midnight) {
        total += BigInt(e.amountAtomic);
      }
    }
    return total;
  }
}
