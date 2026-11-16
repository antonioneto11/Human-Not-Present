import { createInterface } from "node:readline/promises";

export interface ApprovalRequest {
  url: string;
  merchant: string;
  amountUsd: string;
  reason: string;
  policyNote: string;
}

export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/**
 * Human-in-the-loop gate. Interactive terminal → ask. Otherwise fall back to
 * APPROVAL_MODE (default "deny"), so an unattended run can never auto-spend above the threshold.
 */
export const terminalApprover: Approver = async (req) => {
  const mode = (process.env.APPROVAL_MODE ?? "prompt").toLowerCase();
  if (mode === "always") return true;
  if (mode === "never" || !process.stdin.isTTY) {
    console.log(`\n  ⛔ Approval required but no human available (APPROVAL_MODE=${mode}); declining.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n  ┌─ 💳 Approval required ───────────────────────────");
    console.log(`  │ Merchant: ${req.merchant}`);
    console.log(`  │ Resource: ${req.url}`);
    console.log(`  │ Amount:   ${req.amountUsd} USDC`);
    console.log(`  │ Why:      ${req.reason}`);
    console.log(`  │ Policy:   ${req.policyNote}`);
    console.log("  └──────────────────────────────────────────────────");
    const answer = await rl.question("  Approve this payment? [y/N] ");
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
};
