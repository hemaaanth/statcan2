import { readFileSync } from "node:fs";

export type Region = {
  region_id: string;
  label: string;
  kind: "sgc" | "common" | "physiographic";
  members: string[];
  aliases: string[];
  source: string;
  note: string;
};

export const regions: Region[] = readFileSync(new URL("../../data/ref/regions.csv", import.meta.url), "utf8").trim().split("\n").slice(1)
  .map((line) => {
    const [region_id, label, kind, members, aliases, source, note] = line.split(",");
    return {
      region_id: region_id!, label: label!, kind: kind as Region["kind"],
      members: members ? members.split(";") : [], aliases: aliases ? aliases.split(";") : [],
      source: source!, note: note!,
    };
  });

export function findRegion(regionId: string): Region | undefined {
  return regions.find((region) => region.region_id === regionId);
}
