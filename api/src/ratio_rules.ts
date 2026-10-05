import { readFileSync } from "node:fs";

export type RatioRule = {
  measure_pattern: RegExp;
  numerator: string;
  denominator: string;
  scale: number;
  dimension: string;
};

export const ratioRules: RatioRule[] = readFileSync(new URL("../../data/ref/ratio_rules.csv", import.meta.url), "utf8")
  .trim().split(/\r?\n/).slice(1).map((line) => {
    const [pattern, numerator, denominator, scale, dimension] = line.split(",");
    return { measure_pattern: new RegExp(pattern!), numerator: numerator!, denominator: denominator!, scale: Number(scale), dimension: dimension! };
  });

export function findRatioRule(measureLabel: string, dimensionName: string): RatioRule | undefined {
  return ratioRules.find((rule) => rule.dimension === dimensionName && rule.measure_pattern.test(measureLabel));
}
