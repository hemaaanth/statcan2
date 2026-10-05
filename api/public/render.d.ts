// Types for the parts of render.js that pages.ts uses on the server.
import type { PlanResult, ViewResult, ViewSpec } from "../src/spec.ts";

export interface RenderState { q: string; plan: PlanResult | null; spec: ViewSpec | null; view: ViewResult | null; error: string | null; hasZip: boolean }
export interface Parts {
  status: "idle" | "need_more" | "no_match" | "ok" | "error";
  head: string; blank: string; table: string; notes: string; download: string; cite: string; api: string;
  counts: { notes: number; cite: number };
}
export function parts(state: RenderState): Parts;
export function sanitizeNote(input: unknown): string;
/** Finest period spacing in a chart; used to avoid day labels on monthly and quarterly views. */
export function grainOf(view: Pick<ViewResult, "x" | "series">): "category" | "day" | "week" | "month" | "quarter" | "half" | "year";
/** Human-readable span used by the chart footer and subtitle. */
export function periodText(view: Pick<ViewResult, "period" | "sources" | "x" | "series">): string;
