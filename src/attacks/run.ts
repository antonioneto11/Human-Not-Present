/**
 *   npm run attacks
 *
 * Runs every scripted attack under every policy setup. No model, no API calls, no real money.
 * Writes data/attacks/<timestamp>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicToUsd } from "../money";
import { ATTACKS, runSuite, SETUPS, type AttackResult } from "./suite";

const results = await runSuite();

const cell = (r: AttackResult) => {
  const spent = BigInt(r.settledAtomic) > 0n ? ` ${atomicToUsd(r.settledAtomic)}` : "";
  return r.bad ? `❌ BAD${spent}` : `✅ ok${spent}`;
};
const W = 26;
const C = 22;
console.log(`\nAttack suite: ${ATTACKS.length} attacks × ${SETUPS.length} setups (scripted agent, simulated settlement)\n`);
console.log("Attack".padEnd(W) + SETUPS.map((s) => s.short.padEnd(C)).join(""));
console.log("-".repeat(W + C * SETUPS.length));
console.log("(\"yes-human\" = a human approver who approves everything shown to them)\n");
for (const a of ATTACKS) {
  const row = SETUPS.map((s) => cell(results.find((r) => r.attack === a.id && r.setup === s.id)!).padEnd(C)).join("");
  console.log(a.name.padEnd(W) + row);
}

console.log("\nWhat stopped each attack (policy + mandate, human always says yes):");
for (const a of ATTACKS) {
  const r = results.find((x) => x.attack === a.id && x.setup === "mandate_yes")!;
  console.log(`  ${a.name.padEnd(W)} ${r.stoppedBy.join(", ") || "(nothing needed stopping)"}`);
}

const badBySetup = SETUPS.map((s) => ({ setup: s.label, bad: results.filter((r) => r.setup === s.id && r.bad).length }));
console.log("\nBad outcomes per setup:");
for (const b of badBySetup) console.log(`  ${b.setup.padEnd(42)} ${b.bad}/${ATTACKS.length}`);

const outDir = join("data", "attacks");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replaceAll(":", "-").slice(0, 19)}.json`);
writeFileSync(file, JSON.stringify({ setups: SETUPS, attacks: ATTACKS.map(({ id, name, description }) => ({ id, name, description })), results }, null, 2));
console.log(`\nDetails: ${file}`);
