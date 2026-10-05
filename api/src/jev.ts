type Question = { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string | { description: string }> };
export type Questions = Record<string, Question>;
export type Answers = Record<string, { noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;

export function probability(answers: Answers, key: string): number {
  const value = answers[key]?.noul;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function choice(answers: Answers, key: string): { value: string; confidence: number } {
  const answer = answers[key];
  const value = typeof answer?.choice === "string" ? answer.choice : "";
  const confidence = answer?.probabilities?.[value] ?? answer?.confidence ?? 0;
  return { value, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0 };
}

/** One bounded call per planning step; retry only transient failures. */
export async function askJev(state: Record<string, unknown>, questions: Questions, signal?: AbortSignal): Promise<Answers> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("Jev key unavailable");
  for (const [attempt, delay] of [0, 300, 900].entries()) {
    if (delay) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, delay);
      const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); };
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    const timeout = AbortSignal.timeout(15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions }), signal: combined,
      });
      if ((response.status === 429 || response.status === 529) && attempt < 2) continue;
      if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
      const body = await response.json() as { answers?: Answers };
      if (!body.answers) throw new Error("Jev answers missing");
      return body.answers;
    } catch (error) {
      if (signal?.aborted || timeout.aborted || attempt === 2 || error instanceof Error && error.message.startsWith("Jev HTTP")) throw error;
    }
  }
  throw new Error("Jev unavailable");
}
