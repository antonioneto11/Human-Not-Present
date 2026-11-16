/**
 * Delivery check: code, not the model, decides whether paid-for data is usable.
 * Schemas are the BUYER's expectation per product, not anything the merchant supplies.
 */
import { z } from "zod/v4";

export type DeliveryResult =
  | { status: "passed" }
  | { status: "failed"; reason: string }
  | { status: "unchecked"; reason: string };

/** Keyed by URL pathname. */
export type DeliverySpecs = Record<string, z.ZodType>;

export const PRODUCT_SPECS: DeliverySpecs = {
  "/api/weather": z.object({
    city: z.string().min(1),
    temperatureC: z.number(),
    conditions: z.string().min(1),
  }),
  "/api/fx-rates": z.object({
    base: z.literal("USD"),
    rates: z.record(z.string(), z.number().positive()).refine((r) => "EUR" in r, "missing EUR rate"),
  }),
  "/api/market-brief": z.object({
    headline: z.string().min(1),
    bullets: z.array(z.string().min(1)).min(1),
  }),
  "/api/shipping-rates": z.object({
    origin: z.string().min(1),
    destination: z.string().min(1),
    rates: z.array(z.object({ carrier: z.string().min(1), priceUsd: z.number().positive() })).min(1),
  }),
};

function isEmpty(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (typeof body === "string") return body.trim() === "";
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === "object") return Object.keys(body).length === 0;
  return false;
}

export function checkDelivery(url: string, body: unknown, specs: DeliverySpecs = PRODUCT_SPECS): DeliveryResult {
  if (isEmpty(body)) return { status: "failed", reason: "empty response" };
  const spec = specs[new URL(url).pathname];
  if (!spec) return { status: "unchecked", reason: "no buyer-side schema for this product" };
  const parsed = spec.safeParse(body);
  if (parsed.success) return { status: "passed" };
  const issue = parsed.error.issues[0];
  return { status: "failed", reason: `schema mismatch at ${issue.path.join(".") || "(root)"}: ${issue.message}` };
}
