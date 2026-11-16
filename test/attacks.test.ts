/**
 * The attack suite as a regression test. A scripted, compromised agent calls the payment
 * layer directly; ground truth is the simulated settlement ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ATTACKS, runSuite, SETUPS } from "../src/attacks/suite";

const results = await runSuite();
const get = (attack: string, setup: string) => results.find((r) => r.attack === attack && r.setup === setup)!;

test("with the mandate, no attack gets money out, even when the human approves everything", () => {
  for (const setup of ["mandate", "mandate_yes"]) {
    const bad = results.filter((r) => r.setup === setup && r.bad);
    assert.deepEqual(bad.map((r) => `${r.attack}: ${r.badDetails.join("; ")}`), [], setup);
  }
});

test("without the mandate, the known gap is still there (allowlisted merchant, right payee, under every limit)", () => {
  // These document what the base policy cannot see. If one starts passing, the base policy changed.
  for (const attack of ["cheap_upsell", "budget_drain", "repeat_purchase"]) {
    assert.equal(get(attack, "policy").bad, true, attack);
  }
  assert.equal(get("budget_drain", "policy").settledAtomic, "1980000", "drain stops at the $2.00 daily budget");
});

test("bait and switch: declined with no human; settles if a human approves anything; mandate stops it either way", () => {
  assert.equal(get("bait_and_switch", "policy").bad, false);
  assert.equal(get("bait_and_switch", "policy_yes").bad, true);
  assert.ok(get("bait_and_switch", "mandate_yes").stoppedBy.includes("over_mandate_price"));
});

test("protocol-level attacks are stopped in every setup", () => {
  const expected: Record<string, string> = {
    attacker_payee: "payee_mismatch",
    payee_swap: "payee_mismatch",
    wrong_network: "wrong_network",
    wrong_asset: "unsupported_asset",
    settle_switch: "settlement_failed",
    unlisted: "merchant_not_allowlisted",
    redirect: "redirect_refused",
    lookalike_host: "merchant_not_allowlisted",
  };
  for (const [attack, rule] of Object.entries(expected)) {
    for (const s of SETUPS) {
      const r = get(attack, s.id);
      assert.equal(r.bad, false, `${attack} under ${s.id}`);
      assert.equal(r.settledCount, 0, `${attack} under ${s.id} moved money`);
      if (!s.mandate || !["attacker_payee"].includes(attack)) assert.ok(r.stoppedBy.includes(rule), `${attack} under ${s.id}: ${r.stoppedBy}`);
    }
  }
});

test("a duplicate purchase is charged once", () => {
  for (const s of SETUPS) assert.equal(get("duplicate", s.id).settledCount, 1);
});

test("every attack ran under every setup", () => {
  assert.equal(results.length, ATTACKS.length * SETUPS.length);
});
