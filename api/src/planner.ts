import { readFileSync } from "node:fs";
import { tableNumber, type Db, type Row } from "./db.ts";
import { getCube } from "./cube.ts";
import { askJev, choice, probability, type Answers, type Questions } from "./jev.ts";
import { regions, type Region } from "./regions.ts";
import { ADDITIVE_FAMILIES, SPEC_VERSION, ViewSpec, type CubeDimension, type CubeInfo, type CubeMember, type DimensionSel, type MemberSel, type PlanResult, type PlanStep, type TimeWindow, type Transform, type ChartType } from "./spec.ts";
import { runView, type ViewOutcome } from "./view.ts";

type GroupTarget = { label: string; region?: Region; place?: string };
type Cues = { time: TimeWindow; relativeMonths?: number; geography: string; places: string[]; concepts: string[]; groups?: GroupTarget[]; groupTerms?: string[]; byRegion?: boolean; physiographic?: Region; transform?: Transform; indexBase?: string; chart?: ChartType; requestedChart?: ChartType | "pie" | "table"; horizontal?: boolean; fullHistory: boolean; range: boolean; latest: boolean };
type Candidate = { cube: CubeInfo; titleScore: number; active: boolean };
type CatalogConcept = { id: string; label: string; description: string; pids: string[] };
const CONCEPTS: CatalogConcept[] = readFileSync(new URL("../../data/ref/concepts.csv", import.meta.url), "utf8").trim().split("\n").slice(1)
  .map((line) => {
    const [id, label, description, pids] = line.split(",");
    return { id: id!, label: label!, description: description!, pids: pids!.split(";") };
  });
const STOP: Record<string, true> = Object.fromEntries("a an the is are what how of in on for to by with and or vs versus over since from past last this show me compare compared cost data chart rate".split(" ").map((w) => [w, true]));
const WORK_TRAVEL = /\b(?:get|go|travel)(?:s|ing)?\s+to\s+(?:(?:their|the|your|our)\s+)?(?:work|jobs?)\b/i;
const CAR_SALES = /\b(?:car|automobile|motor vehicle)s?\s+sales?\b/i;
const SALES_METRIC = /\b(?:sales|sold|receipts?|turnover|revenue|transactions?)\b/i;
const SYNONYMS: [RegExp, string][] = [
  [/\bcpi\b|\binflation\b|\bprices?\b|\bcost of living\b/i, "consumer price index"],
  [/\bgas\b|\bgasoline\b|\bfuel\b/i, "gasoline"],
  [CAR_SALES, "new motor vehicle sales"],
  [/\bjobs?\b|\bemployment\b|\bunemployment\b|\bjobless(?:ness)?\b/i, "labour force"],
  [WORK_TRAVEL, "main mode of commuting"],
  [/\b(?:bik(?:e|ing)|cycl(?:e|ing))\b/i, "bicycle"],
  [/\brent(?:s|al)?\b/i, "rent"],
  [/\bwages?\b|\bearnings?\b/i, "earnings"],
  [/\bpeople\b|\bpopulation\b/i, "population"],
  [/\bdeaths?\b|\bmortality\b/i, "deaths"],
  [/\bgdp\b/i, "gross domestic product"],
  [/\bsmokers?\b|\bsmoking\b/i, "smoking"],
];
const MEMBER_TERMS: [RegExp, string][] = [
  [/\b(?:gas|gasoline)\b/i, "Gasoline"],
  [/\bfood\b/i, "Food"],
  [/\b(?:rent|rents)\b/i, "Rented accommodation"],
  [/\bshelter\b/i, "Shelter"],
  [/\b(?:jobs|employment)\b/i, "Employment"],
  [/\b(?:to|with|from)\s+(?:the\s+)?(?:u\.?s\.?a?\.?|united states)\b|\bunited states\b/i, "United States"],
];
function termMember(member: CubeMember, label: string, q: string): boolean {
  const name = member.label.toLowerCase();
  if (name === label.toLowerCase()) return true;
  if (label === "Gasoline" && /\b(?:sales?|volumes?|litres?)\b/i.test(q))
    return name === (/\bgross\b/i.test(q) ? "gross sales of gasoline" : "net sales of gasoline");
  if (label === "Food" && /\b(?:retailers?|grocer(?:y|ies))\b/i.test(q))
    return name === (/\bgrocer(?:y|ies)\b/i.test(q) && !/\bfood and beverage\b/i.test(q)
      ? "grocery and convenience retailers" : "food and beverage retailers");
  if (label !== "United States" || !name.startsWith("united states,")) return false;
  if (/\bto\b/i.test(q)) return /\bdestination\b/i.test(member.label);
  if (/\bfrom\b/i.test(q)) return /\borigin\b/i.test(member.label);
  return true;
}

const PLACES: Record<string, string> = {
  ontario: "Ontario", quebec: "Quebec", québec: "Quebec", alberta: "Alberta", manitoba: "Manitoba",
  saskatchewan: "Saskatchewan", "british columbia": "British Columbia", "new brunswick": "New Brunswick",
  "nova scotia": "Nova Scotia", "prince edward island": "Prince Edward Island",
  newfoundland: "Newfoundland and Labrador", "newfoundland and labrador": "Newfoundland and Labrador",
  yukon: "Yukon", nunavut: "Nunavut", "northwest territories": "Northwest Territories", canada: "Canada",
  toronto: "Toronto", vancouver: "Vancouver", montréal: "Montréal", montreal: "Montréal",
  calgary: "Calgary", edmonton: "Edmonton",
};
const ABBREV: Record<string, string> = { ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan", NB: "New Brunswick", NS: "Nova Scotia", PEI: "Prince Edward Island", NL: "Newfoundland and Labrador", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut" };
const PROVINCE_TERRITORY_NAMES = new Set(Object.values(ABBREV));
const TERRITORY_CAPITALS = [
  { name: "Yukon", code: "60", capital: "Whitehorse" },
  { name: "Northwest Territories", code: "61", capital: "Yellowknife" },
  { name: "Nunavut", code: "62", capital: "Iqaluit" },
] as const;
const PLACE_PATTERNS = Object.entries(PLACES).sort(([a], [b]) => b.length - a.length)
  .map(([name, place]) => [place, new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu")] as const);
const GEOGRAPHY_WORDS = new Set([...Object.keys(PLACES),
  ...regions.flatMap((region) => [region.label, ...region.aliases])]
  .flatMap((label) => label.toLowerCase().match(/\p{L}+/gu) ?? []).filter((word) => word.length >= 5));
const KNOWN_WORDS = [...new Set([...GEOGRAPHY_WORDS, "years", "months",
  ...CONCEPTS.flatMap((concept) => concept.label.toLowerCase().match(/\p{L}+/gu) ?? [])])]
  .filter((word) => word.length >= 5);
const KNOWN_WORD_SET = new Set(KNOWN_WORDS);
function normalizeKnownWords(q: string): string {
  return q.replace(/\p{L}{5,}/gu, (written) => {
    const word = written.toLowerCase();
    if (KNOWN_WORD_SET.has(word)) return written;
    let closest: string | undefined;
    let distance = 3;
    let tied = false;
    for (const name of KNOWN_WORDS) {
      const limit = GEOGRAPHY_WORDS.has(name) && word.length >= 7 ? 2 : 1;
      if (Math.abs(name.length - word.length) > limit) continue;
      // A misspelled place keeps its last letter, except a garbled plural (territoriez). Another real name
      // often differs only there (Atlantis, Atlantic).
      if (GEOGRAPHY_WORDS.has(name) && name.at(-1) !== word.at(-1) && name.at(-1) !== "s") continue;
      let previous = Array.from({ length: name.length + 1 }, (_, i) => i);
      for (let i = 1; i <= word.length; i++) {
        const next = [i];
        for (let j = 1; j <= name.length; j++)
          next[j] = Math.min(next[j - 1]! + 1, previous[j]! + 1,
            previous[j - 1]! + Number(word[i - 1] !== name[j - 1]));
        previous = next;
      }
      const value = previous[name.length]!;
      if (value > limit) continue;
      if (value < distance) { closest = name; distance = value; tied = false; }
      else if (value === distance) tied = true;
    }
    return closest && !tied ? closest : written;
  });
}
const TIME_PHRASE = /\bfrom\s+(?:19|20)\d{2}\s+(?:to|through|[-–—])\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}\b|\b(?:past|last)\s+(?:\d+\s+)?(?:years?|months?)\b|\b(?:since|from|starting in|beginning in|in)\s+(?:19|20)\d{2}\b/giu;
function withoutTime(q: string): string {
  return q.replace(TIME_PHRASE, " ").replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
}
function withoutPlaces(q: string, places: string[]): string {
  const named = new Set(places.map((place) => place.toLowerCase()));
  for (const [place, pattern] of PLACE_PATTERNS) if (named.has(place.toLowerCase())) q = q.replace(pattern, " ");
  for (const [code, place] of Object.entries(ABBREV)) if (named.has(place.toLowerCase()))
    q = q.replace(new RegExp(`\\b${code}\\b`, "g"), " ");
  for (const place of places) q = q.replace(new RegExp(`(?<![\\p{L}\\p{N}])${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), " ");
  return q.replace(/\s+/g, " ").trim();
}

/** Sort explicit selections by their mention, never by catalogue member IDs or Jev score. */
export function orderMembersByQuery<T extends { label: string }>(q: string, members: T[]): T[] {
  const position = (label: string): number => {
    const aliases = [label, label.split(",")[0]!,
      ...Object.entries(PLACES).filter(([, place]) => place.toLowerCase() === label.toLowerCase()).map(([name]) => name)];
    const positions = aliases.map((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(q)?.index);
    const code = Object.entries(ABBREV).find(([, place]) => place.toLowerCase() === label.toLowerCase())?.[0];
    if (code) positions.push(new RegExp(`\\b${code}\\b`).exec(q)?.index);
    positions.push(MEMBER_TERMS.find(([, member]) => member.toLowerCase() === label.toLowerCase())?.[0].exec(q)?.index);
    return Math.min(...positions.filter((index): index is number => index !== undefined));
  };
  return members.sort((a, b) => position(a.label) - position(b.label));
}

const PARTS = /\s+(?:vs\.?|versus|compared to|compared with|and|or)\s+/i;
const PRESETS = ["latest", "1Y", "2Y", "5Y", "10Y", "20Y", "max"] as const;
const CHARTS = ["line", "area", "bar", "stacked_bar", "stacked_bar_100", "stacked_area"] as const;
const TRANSFORMS = ["level", "pct_change_yoy", "pct_change_period", "pct_change_window", "index_first", "share_of_x"] as const;
const opts = { queryable: true, limit: 12, offset: 0 };
type CacheEntry = { promise: Promise<PlanResult>; controller: AbortController; waiters: number; pending: boolean };
const cache = new Map<string, CacheEntry>();
const REGION_ALIASES = regions.flatMap((region) =>
  [...new Set([region.label, ...region.aliases, ...(region.region_id === "western" ? ["west"] :
    region.region_id === "eastern" ? ["east"] : region.region_id === "central" ? ["central"] : [])])]
    .map((alias) => ({ region, alias, re: new RegExp(`(?<![\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu") })));

function requestedGroups(q: string, places: string[]): { groups?: GroupTarget[]; physiographic?: Region; terms: string[] } {
  const hits = REGION_ALIASES.flatMap(({ region, alias, re }) =>
    [...q.matchAll(re)].map((match) => ({ region, alias, at: match.index, end: match.index + match[0].length })))
    .sort((a, b) => a.at - b.at || b.end - a.end);
  const distinct: typeof hits = [];
  for (const hit of hits) if (!distinct.length || hit.at >= distinct.at(-1)!.end) distinct.push(hit);
  const physiographic = distinct.find((hit) => hit.region.kind === "physiographic")?.region;
  if (physiographic) return { physiographic, terms: [] };
  if (/\bby region\b/i.test(q)) {
    const standard = ["atlantic", "prairies", "west_coast"].map((id) => regions.find((region) => region.region_id === id)!);
    return { groups: [
      { label: "Atlantic", region: standard[0] }, { label: "Quebec", place: "Quebec" },
      { label: "Ontario", place: "Ontario" }, { label: "Prairies", region: standard[1] },
      { label: "BC", region: standard[2] }, { label: "Territories", region: regions.find((region) => region.region_id === "territories")! },
    ], terms: ["by region"] };
  }
  // "By provinces and territories" names the geography scope, not two groups to aggregate.
  const compare = /\b(?:vs\.?|versus|compared (?:to|with))\b/i.test(q) ||
    /\band\b/i.test(q.replace(/\b(?:by|across|in|for|each|all)\s+(?:(?:the|all)\s+)?provinces\s+and\s+territories\b/gi, " "));
  const named = compare ? [...new Set(places)].filter((place) => place !== "Canada" &&
    !["Toronto", "Vancouver", "Montréal", "Calgary", "Edmonton"].includes(place))
    .flatMap((place) => {
      const pattern = PLACE_PATTERNS.find(([label]) => label === place)?.[1];
      const at = (pattern && new RegExp(pattern.source, "iu").exec(q)?.index) ??
        Object.entries(ABBREV).filter(([, label]) => label === place)
          .map(([code]) => new RegExp(`\\b${code}\\b`).exec(q)?.index)
          .find((index) => index !== undefined);
      return at === undefined || distinct.some((hit) => at >= hit.at && at < hit.end)
        ? [] : [{ at, label: place, place }];
    }) : [];
  if (!compare || !distinct.length || distinct.length + named.length < 2) return { terms: [] };
  const ordered = [
    ...distinct.map(({ at, region, alias }) => ({ at, label: alias.toLowerCase() === "bc" ? "BC" : region.label, region })),
    ...named,
  ].sort((a, b) => a.at - b.at);
  return { groups: ordered.map(({ at: _at, label, ...target }) => ({ label, ...target })),
    terms: distinct.map((hit) => hit.alias) };
}

export function tablePid(q: string): string | undefined {
  const match = q.trim().match(/^(?:([0-9]{2})-([0-9]{2})-([0-9]{4})(?:-01)?|([0-9]{8}))$/);
  return match ? match[4] ?? `${match[1]}${match[2]}${match[3]}` : undefined;
}

export function parseCues(q: string): Cues {
  const lower = q.toLowerCase();
  const basePhrase = lower.match(/\b(?:index(?:ed)?(?:\s+to)?|rebas(?:e|ed)\s+to|relative\s+to)\s+(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)?((?:19|20)\d{2})(?:-(q[1-4]|(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?))?\b/);
  const indexMeaning = !basePhrase?.[0].startsWith("relative") ||
    !/\b(?:percent(?:age)?|pct|growth|change|difference)\b|%/.test(lower) ||
    /\bindexed\b|\brebas(?:e|ed)\b|\bas an? index\b|\bbase\s*100\b|=\s*100\b/.test(lower);
  const month = basePhrase?.[1] ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(basePhrase[1].slice(0, 3)) + 1 : undefined;
  const indexBase = basePhrase && indexMeaning ? `${basePhrase[2]}${month ? `-${String(month).padStart(2, "0")}` : basePhrase[3] ? `-${basePhrase[3].toUpperCase()}` : ""}` : undefined;
  const timeQuery = basePhrase ? lower.replace(basePhrase[0], " ").replace(/\b(?:19|20)\d{2}\s*=\s*100\b/g, " ") : lower;
  const time: TimeWindow = { preset: "max" };
  let relativeMonths: number | undefined;
  const range = timeQuery.match(/\b(19\d{2}|20\d{2})\s*(?:–|—|-|to|through)\s*(19\d{2}|20\d{2})\b/);
  const since = timeQuery.match(/\b(?:since|from|starting in|beginning in)\s*(19\d{2}|20\d{2})\b/);
  const inYear = timeQuery.match(/\bin\s+(19\d{2}|20\d{2})\b/);
  const standaloneYear = timeQuery.match(/\b(19\d{2}|20\d{2})\b/);
  if (range) { time.from = range[1]; time.to = range[2]; }
  else if (since) time.from = since[1];
  else if (inYear || standaloneYear && !/\b(?:past|last)\b/.test(lower)) {
    const year = (inYear ?? standaloneYear)![1]!;
    if (year === String(new Date().getUTCFullYear())) time.preset = "1Y";
    else { time.from = year; time.to = year; }
  }
  else {
    const duration = lower.match(/\b(?:past|last)\s*(\d+)\s*(year|month)s?\b/) ??
      lower.match(/\b(\d+)\s*(y|yr|yrs)\b/);
    if (duration) {
      const months = Number(duration[1]) * (duration[2]!.startsWith("y") ? 12 : 1);
      if ([12, 24, 60, 120, 240].includes(months)) time.preset = `${months / 12}Y` as TimeWindow["preset"];
      else if (months > 0 && months < 1200) relativeMonths = months;
    } else if (/\b(?:past|last)\s+year\b/.test(lower)) time.preset = "1Y";
    else if (/\bthis year\b/.test(lower)) time.preset = "1Y";
    else if (/\b(?:latest|most recent|current|now|today|snapshot|ranking|rank)\b/.test(lower)) time.preset = "latest";
  }
  const places = Object.entries(PLACES).filter(([name]) => new RegExp(`\\b${name}\\b`, "i").test(q)).map(([, label]) => label);
  for (const [code, label] of Object.entries(ABBREV)) if (new RegExp(`\\b${code}\\b`).test(q)) places.push(label);
  const groupIntent = requestedGroups(q, places);
  const geography = groupIntent.groups ? "regions"
    : /\bprovinces?\s+(?:vs|versus|and)\s+territories\b/i.test(q) ? "provinces_and_territories"
    : /\bterritor(?:y|ies)\b/i.test(q) && !places.length ? "territories"
    : /\b(?:by|across|each)\s+(?:cities|city|cmas?|census metropolitan areas?|census agglomerations?)\b/i.test(q) ? "cities"
    : /\b(?:by|across|each)\s+provinces?\b|\bprovinces?\b|\bprovincial\b/i.test(q) ? "provinces"
    : /\bacross canada\b/i.test(q) ? "provinces_and_territories" : places.length ? "listed" : "one";
  const parts = q.split(PARTS).map((s) => s.trim()).filter(Boolean);
  const geoWords = new Set([...Object.keys(PLACES).flatMap(words), ...Object.keys(ABBREV).map((code) => code.toLowerCase()),
    "province", "provinces", "territory", "territories", "year", "years"]);
  const concepts = geography === "provinces_and_territories" || places.length >= 2 && parts.some((part) =>
    words(part).every((term) => geoWords.has(term))) ? [q] : parts;
  const transform = indexBase || /\bindexed\b|\brebas(?:e|ed)\b|\bindex\s+(?:to\s+100|first\s*=\s*100)\b/i.test(q)
    ? "index_first"
    : /\b(?:inflation|growth|grow|grew|grown|change|rate of|go up|gone up|went up|increas(?:e|ed))\b/i.test(q) ||
      /\b(?:yoy|y\s*\/\s*y|year[- ]over[- ]year|annual change|12[- ]month change)\b/i.test(q) ||
      /%\s*change\b/i.test(q) ? "pct_change_yoy"
    : /\bshare\b|\bcomposition\b/i.test(q) ? "share_of_x" : undefined;
  const requestedChart: Cues["requestedChart"] =
    /\bpie(?: chart)?\b/i.test(q) ? "pie"
    : /\b(?:as (?:a )?table|table view|tabular)\b/i.test(q) ? "table"
    : /\bstacked\s+area(?: chart)?\b/i.test(q) ? "stacked_area"
    : /\bstacked\s+(?:bar|column)s?(?: chart)?\b/i.test(q) ? "stacked_bar"
    : /\b(?:horizontal\s+bar|bar|column)(?: chart)?\b/i.test(q) ? "bar"
    : /\barea(?: chart)?\b/i.test(q) ? "area"
    : /\bline(?: chart)?\b/i.test(q) ? "line" : undefined;
  const chart = /\b(?:share|breakdown|composition)\b/i.test(q) ? "stacked_bar" : undefined;
  const latest = /\b(?:latest|current|now|today|most recent|snapshot|ranking|rank)\b/i.test(q);
  const fullHistory = /\b(?:all time|entire history|full history|history|long run)\b/i.test(q);
  const rangeRequested = Boolean(range || since || relativeMonths || time.from && !time.to ||
    ["1Y", "2Y", "5Y", "10Y", "20Y"].includes(time.preset ?? "") || /\bover time\b/i.test(q) || fullHistory);
  return { time, relativeMonths, geography, places: [...new Set(places)], concepts,
    groups: groupIntent.groups, groupTerms: groupIntent.terms, byRegion: /\bby region\b/i.test(q),
    physiographic: groupIntent.physiographic, transform, indexBase, chart, requestedChart,
    horizontal: /\bhorizontal\s+bar\b/i.test(q) ? true : /\bcolumn(?: chart)?\b/i.test(q) ? false : undefined,
    fullHistory, range: rangeRequested, latest };
}

/** Keep the first strong cluster, not every member over an absolute probability cutoff. */
export function relativeMembers(scores: { id: number; score: number }[], max = 12): number[] {
  const sorted = scores.filter((s) => s.score >= 0.52).sort((a, b) => b.score - a.score);
  if (!sorted.length) return [];
  const threshold = Math.max(0.52, sorted[0]!.score - 0.27);
  const top = sorted.filter((s) => s.score >= threshold).slice(0, max);
  let cut = top.length;
  for (let i = 1; i < top.length; i++) if (top[i - 1]!.score - top[i]!.score >= 0.15) { cut = i; break; }
  return top.slice(0, cut).map((s) => s.id);
}

function step(steps: PlanStep[], question: string, answer: string, source: PlanStep["source"], confidence: number | null = null) {
  steps.push({ question, answer, confidence, source });
}

function geographyMatch(member: CubeMember, place: string): boolean {
  if (PROVINCE_TERRITORY_NAMES.has(place) &&
    !member.roles.some((role) => role === "province" || role === "territory")) return false;
  const head = member.label.split(/\s*\(|,/)[0]!.trim();
  const name = head.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const requested = place.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const level = member.place_id?.slice(5, 9);
  if (name === requested) {
    const region = member.label.split(",")[1]?.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    return head.toLowerCase() === place.toLowerCase() || region !== requested ||
      !["0503", "0504"].includes(level ?? "");
  }
  return ["0503", "0504"].includes(level ?? "") && name.includes("-") &&
    name.split(/\s*-\s*/).includes(requested);
}
function territoryProxy(dimension: CubeDimension, territory: (typeof TERRITORY_CAPITALS)[number]): CubeMember | undefined {
  if (dimension.members.some((member) => member.roles.includes("territory") && member.geo_code === territory.code))
    return undefined;
  // A schema:0005 place DGUID embeds the province/territory code immediately after 0005.
  const cities = dimension.members.filter((member) =>
    member.place_id?.slice(5, 9) === "0005" && member.place_id.slice(9, 11) === territory.code);
  return cities.find((member) => member.label.split(",")[0] === territory.capital) ??
    (cities.length === 1 ? cities[0] : undefined);
}

function territoryProxies(dimension: CubeDimension): CubeMember[] {
  return TERRITORY_CAPITALS.flatMap((territory) => territoryProxy(dimension, territory) ?? []);
}

function geographyForPlace(dimension: CubeDimension, place: string, allowProxy = true): CubeMember | undefined {
  const direct = dimension.members.find((member) => geographyMatch(member, place));
  if (direct || !allowProxy) return direct;
  const territory = TERRITORY_CAPITALS.find((candidate) => candidate.name === place);
  return territory ? territoryProxy(dimension, territory) : undefined;
}

function groupCoverage(cube: CubeInfo, group: GroupTarget): number {
  const geography = cube.dimensions.find((d) => d.role === "geography");
  if (!geography) return 0;
  if (group.place) return Number(geography.members.some((member) =>
    (member.roles.includes("province") || member.roles.includes("territory")) && geographyMatch(member, group.place!)));
  const codes = group.region?.members ?? [];
  return geography.members.filter((member) =>
    (member.roles.includes("province") || member.roles.includes("territory")) &&
    codes.includes(member.geo_code ?? "")).length;
}

function selectedGroups(cube: CubeInfo, cues: Cues): DimensionSel["groups"] {
  const geography = cube.dimensions.find((d) => d.role === "geography");
  if (!geography) return [];
  return (cues.groups ?? []).flatMap((target) => {
    if (!groupCoverage(cube, target)) return [];
    const member = target.place ? geography.members.find((item) =>
      (item.roles.includes("province") || item.roles.includes("territory")) && geographyMatch(item, target.place!)) : undefined;
    return [{ label: target.label, members: target.region ? { region: target.region.region_id } : { eq: member!.id },
      agg: "auto" as const, ...(target.region ? { region: target.region.region_id } : {}) }];
  });
}

async function censusPlaces(db: Db, q: string, prefixOnly = false): Promise<string[]> {
  const rows = await db.query(`SELECT DISTINCT short_name, level FROM (
    SELECT split_part(split_part(name_en, ' (', 1), ',', 1) AS short_name, vintage, level FROM place
  ) WHERE vintage = 2021 AND level IN ('schema:0503', 'schema:0504', 'schema:0005')
    AND length(short_name) >= 4 AND (strpos(lower($1), lower(short_name)) > 0 OR
      level IN ('schema:0503', 'schema:0504') AND strpos(short_name, ' - ') > 0) LIMIT 300`, [q]);
  const location = q.match(/\b(?:in|for|near|around)\s+(.+)/i)?.[1];
  const locations = location?.split(PARTS).map((part) => part.trim()
    .replace(/\s+(?:by|since|from|during|for|in|according|over)\b.*$/i, "")
    .replace(/\s*\(.*$|[,?.!].*$/, "").trim()) ?? [];
  const named = rows.flatMap((row) => {
    const name = String(row.short_name);
    const aliases = String(row.level) === "schema:0005" ? [name] : [name, ...name.split(/\s+-\s+/)];
    return aliases.flatMap((alias) => {
      const index = new RegExp(`(?:^|[^\\p{L}\\p{N}])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu").exec(q)?.index;
      return index === undefined || prefixOnly && index !== 0 ||
        location && !locations.some((place) => place.toLowerCase() === alias.toLowerCase())
        ? [] : [{ name: alias, index }];
    });
  }).sort((a, b) => a.index - b.index || b.name.length - a.name.length);
  const found = [...new Set(named.map(({ name }) => name))];
  if (location && (found.length || locations.length >= 2 &&
    locations.every((place) => /^[A-ZÀ-Ý][\p{L}' -]{3,}$/u.test(place))) &&
    /\b(?:vs\.?|versus|compared (?:to|with))\b/i.test(location)) {
    for (const place of locations) {
      if (/^[\p{L}][\p{L}' -]{3,}$/u.test(place) && !found.some((name) => name.toLowerCase() === place.toLowerCase()))
        found.push(place);
    }
  }
  if (found.length) return found;
  const unknown = q.match(/\b(?:in|for|near|around)\s+(?:the\s+)?([A-ZÀ-Ý][\p{L}'-]*(?:\s+[A-ZÀ-Ý][\p{L}'-]*){0,3})/u)?.[1];
  return unknown ? [unknown] : [];
}

function censusGeoMembers(d: CubeDimension, q: string): CubeMember[] {
  const text = q.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const named: CubeMember[] = [];
  const defaults: CubeMember[] = [];
  for (const member of d.members) {
    const level = member.roles.includes("country") ? "country"
      : member.roles.includes("province") || member.roles.includes("territory") ? "province"
        : member.place_id?.slice(5, 9);
    if (level !== "country" && level !== "province" && level !== "0503" && level !== "0504" && level !== "0005") continue;
    if (level === "country" || level === "province") defaults.push(member);
    const name = member.label.split(/\s*\(|,/)[0]!.trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const aliases = ["0503", "0504"].includes(member.place_id?.slice(5, 9) ?? "") && name.includes(" - ")
      ? name.split(/\s+-\s+/) : [name];
    if (aliases.some((alias) => {
      const at = text.indexOf(alias);
      return alias.length >= 4 && at >= 0 && (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) &&
        !/[a-z0-9]/.test(text[at + alias.length] ?? "");
    })) named.push(member);
  }
  const scope = /\b(?:census subdivision|csd|municipalit(?:y|ies)|city of)\b/i.test(q) ? "0005" : "0503";
  named.sort((a, b) => Number(b.place_id?.slice(5, 9) === scope ||
    scope === "0503" && b.place_id?.slice(5, 9) === "0504") -
    Number(a.place_id?.slice(5, 9) === scope ||
      scope === "0503" && a.place_id?.slice(5, 9) === "0504"));
  return [...new Map([...named.slice(0, 240), ...defaults].map((member) => [member.id, member])).values()].slice(0, 254);
}

/** Summary members (a median, a rate, a "($)" figure) that sit beside the parts but carry another unit. */
const STATISTIC_MEMBER = /\((?:\$|%)\)\s*$|^(?:median|average|mean|percentage|percent|rate|ratio|share)\b/i;
const DISTRIBUTION = /\b(?:deciles?|quintiles?|quartiles?|percentiles?)\b/i;
/**
 * The member a distribution chart holds when the query names none: average income of after-tax income, the figure
 * readers expect per decile. Upper limits and market income are first in member order but answer a narrower question.
 */
function distributionDefault(d: CubeDimension, q: string): number {
  const roots = d.members.filter((m) => m.parent_id === null);
  const pick = (re: RegExp) => roots.find((m) => re.test(m.label))?.id;
  return (!/\b(?:limits?|thresholds?|cut-?offs?|shares?)\b/i.test(q) ? pick(/^average\b/i) : undefined) ??
    (!/\b(?:market|total|before-tax|pre-tax)\b/i.test(q) ? pick(/\bafter-tax\b/i) : undefined) ?? d.default_member_id;
}

/** The parts of a breakdown, without summary members, when at least two parts remain. */
function partsOnly(members: CubeMember[]): CubeMember[] {
  const parts = members.filter((m) => !STATISTIC_MEMBER.test(m.label.trim()));
  return parts.length >= 2 ? parts : members;
}

function snapshotCategory(cube: CubeInfo, q: string, dims: Record<string, DimensionSel>): { dimension: CubeDimension; ids: number[] } | undefined {
  const text = q.toLowerCase();
  const candidates = cube.dimensions.flatMap((d) => {
    if (d.role === "geography" || /\b(?:statistics|year)\b/i.test(d.name)) return [];
    let children = d.members.filter((m) => m.parent_id === d.default_member_id);
    if (/\bincome groups?\b/i.test(d.name)) children = d.members.filter((m) => /\$/.test(m.label) && m.parent_id === null);
    if (/\bimmigrant status and period of immigration\b/i.test(d.name) &&
      /\b(?:arrival period|period of immigration)\b/i.test(q)) {
      const immigrant = children.find((m) => m.label === "Immigrants");
      if (immigrant) children = children.flatMap((m) => m.id === immigrant.id
        ? d.members.filter((period) => period.parent_id === immigrant.id) : [m]);
    }
    if (d.role === "measure" && !children.length) children = d.members.filter((m) => !/\b(?:area|density)\b/i.test(m.label));
    children = partsOnly(children);
    if (children.length < 2) return [];
    const terms = words(d.name).filter((term) => term.length >= 3 && !["total", "groups", "census", "number", "status"].includes(term));
    const mentioned = terms.filter((term) => new RegExp(`\\b${term}\\b`, "i").test(q)).length;
    const by = terms.some((term) => new RegExp(`\\bby\\s+(?:\\w+\\s+)?${term}\\b`, "i").test(q));
    const named = children.filter((m) => m.label.length >= 4 && text.includes(m.label.toLowerCase().replace(/s$/, ""))).length;
    const selection = dims[String(d.id)];
    const requestedId = selection?.use === "fixed" && "eq" in selection.members ? selection.members.eq : undefined;
    const requested = requestedId !== undefined && requestedId !== d.default_member_id
      ? d.members.find((m) => m.id === requestedId) : undefined;
    const commuting = /\bmain mode of commuting\b/i.test(d.name) &&
      (/\bcommut(?:e|ing)\b/i.test(q) || WORK_TRAVEL.test(q) ||
        /\b(?:transit|bike|biking|bicycle|cycle|cycling|walk|walking|drive|driving)\b/i.test(q) ||
        requested !== undefined);
    const score = Number(by || commuting) * 20 + mentioned * 5 + named * 10 + (d.role === "measure" ? -5 : 0) +
      (/\b(?:age|gender|sex)\b/i.test(d.name) ? 0 : 2);
    const selectedIds = selection && "in" in selection.members ? selection.members.in.map(Number) : [];
    const selected = named >= 2 && selectedIds.length >= 2 &&
      selectedIds.every((id) => children.some((member) => member.id === id)) ? selectedIds : undefined;
    return [{ dimension: d, ids: selected ?? children.slice(0, 20).map((m) => m.id), score }];
  }).sort((a, b) => b.score - a.score);
  return candidates[0];
}

function snapshotDimensions(cube: CubeInfo, q: string, dims: Record<string, DimensionSel>, cues?: Cues): void {
  if (cube.family !== "census_2021") return;
  const geo = cube.dimensions.find((d) => d.role === "geography");
  const scope = cues?.geography ?? "one";
  const compare = (cues?.places.length ?? 0) >= 2 && (cues?.places.length ?? 0) <= 3 &&
    /\b(?:vs\.?|versus|compared (?:to|with)|and)\b/i.test(q);
  const geoAxis = scope === "provinces" || scope === "provinces_and_territories" || scope === "territories" || scope === "cities" || scope === "regions";
  if (geo) {
    const named = censusGeoMembers(geo, q);
    const requested = named.find((m) => !m.roles.includes("country") && !m.roles.includes("province") && !m.roles.includes("territory"));
    const placeText = q.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const provincial = named.find((m) => (m.roles.includes("province") || m.roles.includes("territory")) &&
      placeText.includes(m.label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()));
    const specific = /\b(?:census subdivision|csd|municipalit(?:y|ies)|city)\b/i.test(q);
    const namedLocality = cues?.places.some((place) => place.toLowerCase() !== provincial?.label.toLowerCase() &&
      place.toLowerCase() !== "canada");
    const compared = compare ? cues!.places.flatMap((place) => {
      const matches = named.filter((m) => geographyMatch(m, place));
      const match = (specific ? matches.find((m) => !m.roles.includes("province") && !m.roles.includes("territory"))
        : matches.find((m) => m.roles.includes("province") || m.roles.includes("territory"))) ?? matches[0];
      return match ? [match.id] : [];
    }) : [];
    const target = specific || namedLocality ? requested ?? provincial : provincial ?? requested ??
      named.find((m) => m.roles.includes("country")) ?? geo.members.find((m) => m.roles.includes("country"));
    const role = scope === "provinces" ? { role: "province" as const } : scope === "territories" ? { role: "territory" as const }
      : { any: [{ role: "province" as const }, { role: "territory" as const }] };
    const cities = geo.members.filter((m) => ["0503", "0504"].includes(m.place_id?.slice(5, 9) ?? ""));
    dims[String(geo.id)] = compare && !compared.length
      ? { use: "fixed", members: { eq: geo.default_member_id } }
      : geoAxis || compare
        ? { use: "x", members: compare ? { in: compared } : scope === "cities"
          ? { in: cities.slice(0, 254).map((m) => m.id) } : role }
        : { use: "fixed", members: { eq: target?.id ?? geo.default_member_id } };
  }
  const axis = snapshotCategory(cube, q, dims);
  const subject = expanded(q).join(" ");
  const subjectWords = new Set(words(subject));
  for (const d of cube.dimensions) {
    if (d.role === "geography" || d.id === axis?.dimension.id) continue;
    const selected = dims[String(d.id)];
    if (!selected) continue;
    const namedDimension = words(d.name).filter((term) =>
      !["census", "number", "total", "groups", "status", "time", "work", "commuting", "mode"].includes(term))
      .some((term) => subjectWords.has(term)) ||
      d.members.some((m) => m.id !== d.default_member_id && m.label.length >= 4 &&
        new RegExp(`\\b${m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(subject));
    if (selected.use === "x" || selected.use === "series" && !namedDimension)
      dims[String(d.id)] = namedDimension && (geoAxis || compare) && selected.use === "x"
        ? { ...selected, use: "series" } : { use: "fixed", members: { eq: d.default_member_id } };
    else if (selected.use === "fixed" && "eq" in selected.members && selected.members.eq !== d.default_member_id) {
      const id = selected.members.eq;
      const member = d.members.find((m) => m.id === id);
      const terms = words(member?.label ?? "").filter((term) =>
        !["census", "family", "total", "number", "persons", "population", "counts"].includes(term));
      if (member && !q.toLowerCase().includes(member.label.toLowerCase()) &&
        !terms.some((term) => words(q).includes(term)))
        dims[String(d.id)] = { use: "fixed", members: { eq: d.default_member_id } };
    }
  }
  if (axis) {
    const mentioned = expanded(q).join(" ");
    const named = axis.dimension.members.filter((m) => m.parent_id != null &&
      m.parent_id !== axis.dimension.default_member_id && m.label.length >= 4 &&
      (m.label === "Public transit" && /\btransit\b/i.test(q) ||
        new RegExp(`\\b${m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(mentioned)));
    const raw = dims[String(axis.dimension.id)];
    const chosenId = raw?.use === "fixed" && "eq" in raw.members ? raw.members.eq : undefined;
    const chosen = chosenId === undefined ? undefined : axis.dimension.members.find((m) =>
      m.id === chosenId && m.id !== axis.dimension.default_member_id);
    const requested = named.length ? named : /\bmain mode of commuting\b/i.test(axis.dimension.name) && chosen ? [chosen] : [];
    const members = requested.length ? orderMembersByQuery(q, requested).map((member) => {
      if (!/\bmain mode of commuting\b/i.test(axis.dimension.name)) return member.id;
      const parent = axis.dimension.members.find((m) => m.id === member.parent_id);
      return parent && (parent.label === "Public transit" || member.label.startsWith(`${parent.label} -`))
        ? parent.id : member.id;
    }) : axis.ids;
    dims[String(axis.dimension.id)] = { use: geoAxis || compare ? "series" : "x",
      members: { in: [...new Set(members)] } };
  }
}

function headline(cube: CubeInfo, time: TimeWindow = { preset: "max" }): ViewSpec {
  const dims: Record<string, DimensionSel> = Object.fromEntries(cube.dimensions.map((d) =>
    [d.id, { use: "fixed", members: { eq: d.default_member_id } }]));
  snapshotDimensions(cube, "", dims);
  return { v: SPEC_VERSION, layers: [{ pid: cube.pid, dims }],
    time: cube.kind === "snapshot" ? { preset: "latest" } : time, transform: "level", chart: { type: cube.kind === "snapshot" ? "bar" : "line" } };
}


function memberCount(d: CubeDimension, sel: DimensionSel): number {
  if (sel.groups) return sel.groups.length;
  const members = sel.members;
  if ("in" in members) return members.in.length;
  if ("role" in members) return d.members.filter((m) => m.roles.includes(members.role)).length;
  if ("any" in members) return d.members.filter((m) => members.any.some((part) =>
    "role" in part && m.roles.includes(part.role))).length;
  return d.members.length;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-zà-ÿ0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP[w] && !/^(?:19|20)\d{2}$/.test(w));
}
function singular(word: string): string {
  return word.endsWith("ies") ? `${word.slice(0, -3)}y`
    : /(?:sses|xes|ches|shes)$/.test(word) ? word.slice(0, -2)
    : word.length > 3 ? word.replace(/s$/, "") : word;
}
function expanded(text: string) {
  return [text, ...SYNONYMS.filter(([re]) => re.test(text)).map(([, synonym]) => synonym)];
}
function matches(label: string, q: string): number {
  const name = label.toLowerCase();
  return words(q).reduce((score, token) => score + (new RegExp(`\\b${token}\\b`, "i").test(name) ? 1 : 0), 0);
}

function conceptQuestion(): Questions {
  return { concept: { type: "choice", instructions: "Choose the single closest statistical concept to the primary subject of the user's request. Descriptions explain coverage; a comparison can use one concept whose table contains both categories. Choose none for unrelated requests.",
    criteria: Object.fromEntries([...CONCEPTS.map(({ id, label, description }) => [id, { description: `${label}: ${description}` }]), ["none", { description: "No relevant statistical concept." }]]) } };
}
function lexicalConcept(part: string, censusOnly = false): CatalogConcept | undefined {
  const eligible = CONCEPTS.filter((concept) => !censusOnly || concept.id.startsWith("census_"));
  const score = (concept: CatalogConcept, phrase: string) =>
    matches(concept.label, phrase) * 2 + matches(concept.description, phrase);
  let best: CatalogConcept | undefined;
  let highest = 1;
  for (const concept of eligible) {
    if (!matches(concept.label, part)) continue;
    const value = score(concept, part);
    if (value > highest) { best = concept; highest = value; }
  }
  if (best) return best;
  for (const concept of eligible) {
    const value = Math.max(...expanded(part).slice(1).map((phrase) => score(concept, phrase)), 0);
    if (value > highest) { best = concept; highest = value; }
  }
  return best;
}

function titleScore(title: string, q: string): number {
  return Math.max(...expanded(q).map((phrase) => matches(title, phrase)));
}

function covers(cube: CubeInfo, q: string): boolean {
  const core = words(q).filter((term) => !["census", "province", "provinces", "territory", "territories", "monthly", "annual", "latest", "year", "years"].includes(term) && !Object.keys(PLACES).includes(term));
  const terms = expanded(q);
  const needed = Math.min(2, Math.max(1, core.length,
    terms.some((phrase, index) => index > 0 && phrase.includes(" ")) ? 2 : 1));
  return MEMBER_TERMS.some(([re, label]) => re.test(q) && cube.dimensions.some((d) => d.members.some((m) => termMember(m, label, q)))) ||
    terms.some((phrase) => matches(cube.title, phrase) >= needed) ||
    cube.dimensions.some((d) => d.members.some((m) => terms.some((phrase) => matches(m.label, phrase) >= needed)));
}
function metricFits(cube: CubeInfo, q: string): boolean {
  const sales = /\b(?:sales?|receipts?|turnover|revenue|transactions?)\b/i.test(q);
  const title = cube.title.toLowerCase();
  if (sales && !SALES_METRIC.test(title) &&
    !cube.dimensions.some((d) => d.role === "measure" && d.members.some((m) =>
      SALES_METRIC.test(m.label) && !/\b(?:buyers?|prices?)\b/i.test(m.label)))) return false;
  if (sales && /\b(?:prices?|indices?|indexes?)\b/i.test(title) && !/\b(?:sales?|receipts?|revenue)\b/i.test(title)) return false;
  const resale = /\b(?:resales?|resold|existing homes?|existing houses?)\b/i;
  if (resale.test(q) &&
    (!/\b(?:homes?|housing|houses?|residential|real estate|propert(?:y|ies)|dwellings?)\b/i.test(title) ||
      !resale.test(title) && !cube.dimensions.some((d) => d.role === "measure" &&
        d.members.some((m) => resale.test(m.label))))) return false;
  if (/\b(?:restaurants?|food services?|eating places|dining out)\b/i.test(q) && sales &&
    !/\bfood services and drinking places\b/i.test(title)) return false;
  if (/\b(?:average retail prices?|retail prices? in dollars?|dollar prices?)\b/i.test(q) &&
    !/\baverage retail prices?\b/i.test(title)) return false;
  if (/\bdollars?\b|\$/i.test(q) && /\bprices?\b/i.test(q) &&
    !cube.unit_families.includes("currency")) return false;
  if (/\b(?:sales?|volumes?)\b/i.test(q) && /\b(?:litres?|liters?)\b/i.test(q) &&
    !cube.dimensions.some((d) => d.members.some((m) => /\b(?:sales?|volumes?)\b/i.test(m.label)))) return false;
  if (/\b(?:deaths?|mortality)\b.*\bcauses?\b|\bcauses?\b.*\b(?:deaths?|mortality)\b/i.test(q) &&
    !cube.dimensions.some((d) => /\bcauses? of death\b/i.test(d.name))) return false;
  return true;
}
function supports(cube: CubeInfo, q: string, cues: Cues, allowMissing = false): boolean {
  // Table frequency labels can differ from the cleaned observations; only reject
  // an explicitly contradictory frequency in the table title.
  if (/\bmonthly\b/i.test(q) && /\bannual|quarterly\b/i.test(cube.title) ||
    /\bquarterly\b/i.test(q) && /\bannual|monthly\b/i.test(cube.title) ||
    /\b(?:annual|annually)\b/i.test(q) && /\bmonthly|quarterly\b/i.test(cube.title)) return false;
  if (!metricFits(cube, q)) return false;
  const geo = cube.dimensions.find((d) => d.role === "geography");
  if (cues.groups && !cues.groups.some((group) => groupCoverage(cube, group))) return false;
  if (cues.geography === "provinces" || cues.geography === "provinces_and_territories")
    if (!geo?.members.some((m) => m.roles.includes("province"))) return false;
  if (cues.geography === "territories" || cues.geography === "provinces_and_territories")
    if (!geo?.members.some((m) => m.roles.includes("territory")) &&
      (!geo || !territoryProxies(geo).length)) return false;
  if (cube.family === "census_2021" && cues.geography === "cities" &&
    !geo?.members.some((m) => ["0503", "0504"].includes(m.place_id?.slice(5, 9) ?? ""))) return false;
  if (cube.family === "census_2021" && /\b(?:census subdivision|csd|municipalit(?:y|ies))\b/i.test(q) &&
    !geo?.members.some((m) => m.place_id?.slice(5, 9) === "0005")) return false;
  const matchedPlaces = cues.places.map((place) => geo && geographyForPlace(geo, place,
    !cues.groups && !/\b(?:sum|combined total|add up|ratio)\b/i.test(q)))
    .filter((member): member is CubeMember => member !== undefined);
  if (cues.places.length && (!matchedPlaces.length || !allowMissing && matchedPlaces.length !== cues.places.length))
    return false;
  if (cube.family === "census_2021" && cues.places.length >= 2 && cues.places.length <= 3 &&
    /\b(?:vs\.?|versus|compared (?:to|with)|and)\b/i.test(q) &&
    new Set(matchedPlaces.map((member) => member.id)).size !== matchedPlaces.length)
    return false;
  return MEMBER_TERMS.filter(([, label]) => ["Gasoline", "Food", "United States"].includes(label))
    .every(([re, label]) => !re.test(q) || cube.title.toLowerCase().includes(label.toLowerCase()) ||
      cube.dimensions.some((d) => d.members.some((m) => termMember(m, label, q))));
}

async function candidates(db: Db, q: string, cues: Cues, concept?: CatalogConcept, parts: (CatalogConcept | undefined)[] = []): Promise<Candidate[]> {
  const searches = new Set<string>();
  const stripped = q.replace(/\b(?:since|in)\s+(?:19|20)\d{2}\b|\b(?:past|last)\s+(?:\d+\s+)?(?:year|month)s?\b/gi, "")
    .replace(/\b(?:by|across|each)\s+provinces?\b/gi, "").trim();
  for (const part of [...cues.concepts, stripped]) {
    const terms = words(part).filter((w) => !Object.keys(PLACES).includes(w));
    if (terms.length && terms.length <= 5) searches.add(terms.join(" "));
    for (const phrase of expanded(part)) if (phrase !== part) searches.add(phrase);
    for (const token of terms.slice(0, 2)) searches.add(token);
  }
  const found = await Promise.all([...searches].slice(0, 3).map((s) => db.search(s, opts).catch(() => ({ rows: [] as Row[] }))));
  const ranked = new Map<string, { row: Row; score: number }>();
  for (const result of found) for (const row of result.rows) {
    const pid = String(row.pid);
    const title = String(row.title_en).toLowerCase();
    const queryTerms = words(q);
    const score = Number(row.title_hits ?? 0) * 3 + Number(row.member_hits ?? 0) +
      queryTerms.reduce((sum, token) => sum + (title.includes(token) ? 2 : 0), 0) +
      SYNONYMS.reduce((sum, [re, synonym]) => sum + (re.test(q) && title.includes(synonym) ? 7 : 0), 0) +
      (row.archived === "2" ? 2 : 0) + (row.period_max ? 1 : 0);
    const old = ranked.get(pid);
    if (!old || score > old.score) ranked.set(pid, { row, score });
  }
  const related = concept && cues.geography !== "one"
    ? CONCEPTS.filter((other) => other !== concept && matches(other.label, concept.label) >= 2).slice(0, 3) : [];
  const preferred = [...new Set([...(concept?.pids ?? []), ...parts.flatMap((part) => part?.pids ?? []),
    ...related.flatMap((entry) => entry.pids)])].filter((pid) => db.info.get(pid)?.queryable);
  const ordered = [
    ...preferred.map((pid) => ranked.get(pid) ?? { row: { pid, title_en: db.info.get(pid)!.title_en }, score: 0 }),
    ...[...ranked.values()].sort((a, b) => b.score - a.score),
  ].filter((item, i, items) => items.findIndex((other) => other.row.pid === item.row.pid) === i)
    .filter(({ row }) => /\b(?:basket|weights?)\b/i.test(q) || !/\bbasket weights?\b/i.test(String(row.title_en)));
  const metadata = ordered.length ? await db.query(`SELECT pid, archived, period_max FROM tables WHERE pid IN (${ordered.map((_, i) => `$${i + 1}`).join(", ")})`,
    ordered.map(({ row }) => String(row.pid))) : [];
  const byPid = new Map(metadata.map((row) => [String(row.pid), row]));
  const freshYear = new Date().getUTCFullYear() - 3;
  const current = ordered.map((item) => {
    const row = byPid.get(String(item.row.pid));
    const year = row?.period_max ? new Date(row.period_max as string).getUTCFullYear() : 0;
    const family = db.info.get(String(item.row.pid))?.family;
    return { ...item, active: row?.archived === "2" && (year >= freshYear ||
      family === "census_2021" && !cues.range) };
  });
  const active = current.filter((item) => item.active);
  const inactive = current.filter((item) => !item.active);
  // A census concept lists a WDS table only as its time-trend alternative; without a range, keep the census tables.
  const preferPublished = concept?.pids.some((pid) => db.info.get(pid)?.family === "wds") &&
    !/\bcensus\b/i.test(q) && (!concept.id.startsWith("census_") || Boolean(cues.range));
  let unknownCensus = 0;
  const shortlist = [...active.slice(0, 10), ...inactive.slice(0, Math.max(2, 12 - active.length))].slice(0, 12)
    .filter(({ row }) => {
      const pid = String(row.pid);
      if (db.info.get(pid)?.family !== "census_2021") return true;
      if (preferPublished) return false;
      if (concept?.id.startsWith("census_"))
        return concept.pids.includes(pid) || parts.some((part) => part?.pids.includes(pid));
      return unknownCensus++ === 0;
    });
  const cubes = await Promise.all(shortlist.map((item) => getCube(db, String(item.row.pid))));
  return shortlist.flatMap((item, i) => cubes[i] ? [{
    cube: cubes[i]!, titleScore: titleScore(cubes[i]!.title, q), active: item.active,
  }] : []);
}

function preview(cube: CubeInfo, q: string, index: number) {
  return { id: `t${index}`, pid: cube.pid, title: cube.title, frequency: cube.frequency, period: [cube.period_min, cube.period_max],
    family: cube.family, dimensions: cube.dimensions.map((d) => ({
      id: d.id, name: d.name, role: d.role,
      members: [...(cube.family === "census_2021" && d.role === "geography" ? censusGeoMembers(d, q) : d.members)]
        .sort((a, b) => matches(b.label, q) - matches(a.label, q) || a.depth - b.depth)
        .slice(0, 15).map((m) => m.label),
    })) };
}

function initialQuestions(list: Candidate[], concept?: CatalogConcept): Questions {
  const questions: Questions = {
    enough: { type: "noul", instructions: "Is this typed query specific enough to choose a meaningful Statistics Canada chart? A topic or table name such as CPI is enough; fragments, filler words, and unrelated requests are not." },
    related: { type: "noul", instructions: "Is this query about Canadian statistics or data that Statistics Canada could publish? Recipes, sports trivia and programming help are unrelated." },
    table: { type: "choice", instructions: `Choose the best listed table for the primary statistical subject. ${concept ? `The selected concept is ${concept.label}: ${concept.description}. Its ordered tables are ${concept.pids.join(", ")}; prefer the first current table that covers the request.` : ""} Prefer a current active table with recent data over an inactive or stale table; use inactive only when no current table covers the requested statistic. Do not substitute a price index for sales or a retail industry for restaurants. Prefer a single table covering all named places and compared categories. A table with the main concept but missing a subgroup is still a valid partial match. For comparisons needing separate tables select the primary and mark other tables needed. Pick none only if every table is unrelated.`,
      criteria: Object.fromEntries([...list.map(({ cube, active }, i) => [`t${i}`, { description: `${cube.title} (${active ? "current" : "inactive or historical"}; through ${cube.period_max ?? "unknown"}); ${cube.dimensions.map((d) => d.name).join(", ")}` }]), ["none", "Every candidate is unrelated to the main concept."]]) },
    time: { type: "choice", instructions: "Choose the time window explicitly requested in the query; otherwise use the last five years available, or all available annual observations if fewer than five.", criteria: Object.fromEntries(PRESETS.map((p) => [p, p])) },
    chart: { type: "choice", instructions: "With multiple periods, default to a time-axis line and put requested breakdowns in series. Use a latest-period category bar for snapshots, explicitly requested bars, or more than 13 series. Respect an explicitly requested supported chart type.", criteria: Object.fromEntries(CHARTS.map((p) => [p, p])) },
    transform: { type: "choice", instructions: "Use published levels unless the query asks for inflation, growth, change, or another transform. A past/last time window alone does not request a transform.", criteria: Object.fromEntries(TRANSFORMS.map((p) => [p, p])) },
  };
  list.forEach(({ cube }, i) => { questions[`t${i}.needed`] = { type: "noul", instructions: `Does the query need data specifically from ${cube.title} (${cube.pid}) in addition to its best table? Do not select a second table if one table has both compared members.` }; });
  return questions;
}

function relevantMembers(d: CubeDimension, q: string) {
  const expandedQ = expanded(q).join(" ");
  return [...d.members].sort((a, b) =>
    (b.id === d.default_member_id ? 100 : 0) + matches(b.label, expandedQ) * 10 - b.depth -
    ((a.id === d.default_member_id ? 100 : 0) + matches(a.label, expandedQ) * 10 - a.depth));
}
function requestedMeasure(d: CubeDimension, q: string): number[] {
  if (d.role !== "measure") return [];
  if (/\bwages?\b/i.test(q) && !/\b(?:number|count|total|people|persons|workers|employees)\b/i.test(q)) {
    const wageRate = d.members.find((member) => /^Average hourly wage rate$/i.test(member.label));
    if (wageRate) return [wageRate.id];
  }
  if (d.name !== "Labour force characteristics") {
    const terms = words(q).map((term) => new RegExp(`\\b${term}\\b`, "i"));
    let best: CubeMember | undefined;
    let score = 0;
    let tied = false;
    for (const member of d.members) {
      const count = terms.reduce((n, term) => n + Number(term.test(member.label)), 0);
      if (count > score) { best = member; score = count; tied = false; }
      else if (count === score) tied = true;
    }
    return best && score >= 2 && !tied ? [best.id] : [];
  }
  const member = (label: string) => d.members.find((m) => m.label === label)?.id;
  // Comparing two metrics is different from comparing ages or genders of one metric.
  if (/\b(?:employment|unemployment)\s+(?:vs\.?|versus|and|compared to)\s+(?:employment|unemployment)\b/i.test(q))
    return ["Employment", "Unemployment"].flatMap((label) => member(label) ?? []);
  const count = /\b(?:number|count|total|people|persons|workers)\s+(?:of\s+)?(?:the\s+)?(?:unemployed|unemployment)\b/i.test(q);
  const label = /\b(?:unemployment|jobless(?:ness)?)\b/i.test(q) ? count ? "Unemployment" : "Unemployment rate"
    : /\bemployment rate\b|\bemployed share\b/i.test(q) ? "Employment rate"
    : /\bparticipation\b/i.test(q) ? "Participation rate"
    : /\b(?:employment|employed|jobs?)\b/i.test(q) ? "Employment" : undefined;
  return label ? [member(label)].filter((id): id is number => id !== undefined) : [];
}

async function dimensions(cube: CubeInfo, q: string, cues: Cues, signal?: AbortSignal, useJev = true): Promise<{ dims: Record<string, DimensionSel>; steps: PlanStep[] }> {
  const questions: Questions = {};
  const picked = new Map<number, CubeMember[]>();
  for (const d of cube.dimensions.filter((d) => d.members.length > 1)) {
    const members = relevantMembers(cube.family === "census_2021" && d.role === "geography"
      ? { ...d, members: censusGeoMembers(d, q) } : d, q);
    picked.set(d.id, members);
    if (cube.family === "census_2021" && d.role === "geography") continue;
    const prefix = `d${d.id}`;
    questions[`${prefix}.use`] = { type: "choice", instructions: `Query: ${q}. Table: ${cube.title}. Dimension: ${d.name} (${d.role}). Should this dimension be fixed to one member, vary as separate series, or become bar-chart x categories?`,
      criteria: { fixed: "One member filters the data.", series: "Several members become separately coloured series.", x: "Several members become categories on the x axis." } };
    const parts = d.role !== "geography" && cues.concepts.length > 1 ? cues.concepts : [q];
    for (const [partIndex, part] of parts.entries()) for (let offset = 0; offset < members.length; offset += 254) {
      const chunk = members.slice(offset, offset + 254);
      questions[`${prefix}.part${partIndex}.chunk${offset / 254}`] = {
        type: "choice",
        instructions: `Query segment: ${part}. Full query: ${q}. Table: ${cube.title}. Dimension: ${d.name}. Select the geographic place or category meant by this segment. Prefer the broad Food member for general food and grocery language; reserve store-only and restaurant-only members for explicitly narrower requests. Road-vehicle fuel corresponds to Gasoline rather than household heating fuel or a combined food-and-energy total. Otherwise prefer an aggregate parent when the term covers a whole category. Choose none if the segment does not specify this dimension. Never choose an excluded component for an included one.`,
        criteria: Object.fromEntries([...chunk.map((m) => [`m${m.id}`, { description: m.label }]), ["none", { description: "No member of this dimension is requested in this segment." }]]),
      };
    }
    questions[`${prefix}.fixed`] = { type: "choice", instructions: `Query: ${q}. Table: ${cube.title}. Dimension: ${d.name}. Choose the single member that matches the user, or the default total for an unspecified dimension.`,
      criteria: Object.fromEntries(members.slice(0, 254).map((m) => [`m${m.id}`, { description: m.label }])) };
    for (const m of members.slice(0, 40)) questions[`${prefix}.m${m.id}`] = { type: "noul",
      instructions: `Query: ${q}. Table: ${cube.title}. Dimension: ${d.name}. Should ${m.label} be explicitly included among the plotted members? Exclude broad totals when specific components are requested.` };
    if (d.role === "geography") questions[`${prefix}.set`] = { type: "choice",
      instructions: `Query: ${q}. Table: ${cube.title}. Geography dimension: ${d.name}. Choose exactly the requested geographic scope.`,
      criteria: { one: "One default country/place.", listed: "Only places named explicitly.", provinces: "All provinces, not territories.", provinces_and_territories: "All provinces and territories.", territories: "Only territories.", all: "All geography members." } };
  }
  let answers: Answers = {};
  if (useJev && Object.keys(questions).length) answers = await askJev({ q, title: cube.title, dimensions: cube.dimensions.map((d) => ({ id: d.id, name: d.name, role: d.role, members: picked.get(d.id)?.slice(0, 40).map((m) => ({ id: m.id, label: m.label, roles: m.roles })) })) }, questions, signal);
  const dims: Record<string, DimensionSel> = {};
  const byWords = new Set([...q.matchAll(/\bby\s+([\p{L}\p{N}-]+(?:\s+(?!(?:in|of|for|since|from|during|over|past|last|with|as)\b)[\p{L}\p{N}-]+){0,2})/giu)]
    .flatMap((match) => words(match[1] ?? "").map(singular)).flatMap((word) => word === "sex" ? [word, "gender"] : [word]));
  const steps: PlanStep[] = [];
  for (const d of cube.dimensions) {
    const prefix = `d${d.id}`;
    const selected = picked.get(d.id) ?? d.members;
    const explicit = MEMBER_TERMS.filter(([re]) => re.test(q)).map(([, label]) => label);
    const matched = selected.filter((m) => matches(m.label, expanded(q).join(" ")) > 0 && m.id !== d.default_member_id &&
      (!/\bexclud(?:e|ing)\b/i.test(m.label) || /\bexclud(?:e|ing)\b/i.test(q)));
    const named = d.role === "geography"
      ? cues.places.flatMap((place) => {
        const direct = selected.filter((member) => geographyMatch(member, place));
        if (direct.length) return direct;
        const proxy = geographyForPlace(d, place, !cues.groups && !/\b(?:sum|combined total|add up|ratio)\b/i.test(q));
        return proxy && selected.some((item) => item.id === proxy.id) ? [proxy] : [];
      })
      : selected.filter((m) => explicit.some((label) => termMember(m, label, q)) ||
        matched.includes(m) && new RegExp(`\\b${m.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(q) &&
        !matched.some((n) => n.id !== m.id && n.label.toLowerCase().startsWith(`${m.label.toLowerCase()} `) && q.toLowerCase().includes(n.label.toLowerCase())));
    const namedMembers = orderMembersByQuery(q, [...new Map(named.map((m) => [m.id, m])).values()]);
    const parts = d.role !== "geography" && cues.concepts.length > 1 ? cues.concepts : [q];
    const semantic = parts.flatMap((part, partIndex) => {
      const candidates: { member: CubeMember; confidence: number }[] = [];
      for (let offset = 0; offset < selected.length; offset += 254) {
        const answer = choice(answers, `${prefix}.part${partIndex}.chunk${offset / 254}`);
        const member = selected.slice(offset, offset + 254).find((m) => `m${m.id}` === answer.value);
        if (member && (!/\bexclud(?:e|ing)\b/i.test(member.label) || /\bexclud(?:e|ing)\b/i.test(part)))
          candidates.push({ member, confidence: answer.confidence });
      }
      const specific = candidates.filter(({ member }) => member.id !== d.default_member_id);
      const chosen = (specific.length ? specific : candidates).sort((a, b) => b.confidence - a.confidence)[0];
      return chosen ? [chosen.member] : [];
    });
    const semanticMembers = [...new Map(semantic.map((m) => [m.id, m])).values()];
    const categoryRequested = d.role === "category" && (
      /\bNAICS\b/i.test(d.name) && /\bindustr(?:y|ies)\b/i.test(q) ||
      /\bNAPCS\b/i.test(d.name) && /\b(?:commodit(?:y|ies)|products?)\b/i.test(q));
    const dimensionTerms = words(d.name);
    // Deciles, quintiles and percentiles are one ordered distribution: any of these words asks for its parts.
    const distribution = d.role !== "geography" && DISTRIBUTION.test(d.name) && DISTRIBUTION.test(q);
    const byDimension = d.role !== "geography" && dimensionTerms.some((word) => byWords.has(singular(word))) || distribution;
    const dimensionMentioned = dimensionTerms.filter((word) => words(q).includes(word)).length >= 2 || byDimension;
    const measure = requestedMeasure(d, q);
    const passengerCar = /\b(?:cars?|automobiles?)\b/i.test(q) && !/\b(?:trucks?|motor vehicles?)\b/i.test(q) &&
      d.name === "Vehicle type" ? d.members.find((m) => /^Passenger cars$/i.test(m.label)) : undefined;
    const relevant = d.role === "geography" ? cues.geography !== "one" || semanticMembers.some((m) => m.id !== d.default_member_id)
      : passengerCar !== undefined || measure.length > 0 || dimensionMentioned || namedMembers.length > 0 ||
        semanticMembers.some((m) => m.id !== d.default_member_id) ||
        matched.some((m) => matches(m.label, q) >= 2) || categoryRequested;
    const geo = d.role === "geography" ? cues.geography : "one";
    const geoRole: MemberSel | undefined = geo === "provinces" ? { role: "province" }
      : geo === "territories" ? { role: "territory" }
      : geo === "provinces_and_territories" ? { any: [{ role: "province" }, { role: "territory" }] }
      : geo === "all" ? { all: true } : undefined;
    const scores = selected.slice(0, 40).map((m) => ({ id: m.id, score: probability(answers, `${prefix}.m${m.id}`) }));
    const fixed = choice(answers, `${prefix}.fixed`);
    const jevMember = selected.find((m) => `m${m.id}` === fixed.value);
    const rent = cues.concepts.length === 1 && explicit.includes("Rented accommodation")
      ? namedMembers.find((m) => m.label === "Rented accommodation") : undefined;
    const broad = namedMembers.length ? [] : /\b(?:by|across|each) industr(?:y|ies)\b/i.test(q) && /\bNAICS\b/i.test(d.name)
      ? d.members.filter((m) => /^\[(?:\d{2}|\d{2}-\d{2})\]$/.test(m.classification_code ?? "") && m.classification_code !== "[00]").map((m) => m.id)
      : /\bby (?:commodit(?:y|ies)|products?)\b/i.test(q) && /\bNAPCS\b/i.test(d.name)
        ? d.members.filter((m) => m.parent_id === d.default_member_id).map((m) => m.id) : [];
    // A measure dimension can hold parts too: "population by age group" splits All ages into 5-year groups.
    const children = distribution && !namedMembers.length
      ? partsOnly(d.members.filter((member) => !member.roles.includes("total"))).map((member) => member.id)
      : (d.role === "category" || d.role === "measure") && byDimension && !broad.length && namedMembers.length < 2
      ? partsOnly(d.members.filter((member) => member.parent_id === (namedMembers[0]?.id ?? d.default_member_id))).map((member) => member.id)
      : [];
    const breakdown = children.length > 1 || namedMembers.length || !byDimension || d.role !== "category" || broad.length
      ? children : d.members.filter((member) => member.parent_id === null).map((member) => member.id);
    const ambiguous = d.role !== "geography" && !geoRole && !rent && cues.concepts.length === 1 && matched.length > 1;
    const ids = measure.length ? measure : passengerCar ? [passengerCar.id] : broad.length ? broad
      : breakdown.length > 1 ? breakdown : rent ? [rent.id] : semanticMembers.length > 1 ? semanticMembers.map((m) => m.id)
      : namedMembers.length > 1 ? namedMembers.map((m) => m.id)
      : semanticMembers.length && relevant ? semanticMembers.map((m) => m.id)
      : ambiguous ? jevMember ? [jevMember.id] : namedMembers.length ? [namedMembers[0]!.id] : relativeMembers(scores).slice(0, 1)
      : namedMembers.length ? namedMembers.map((m) => m.id) : relevant ? relativeMembers(scores) : [];
    const multiple = Boolean(geoRole || geo === "listed" && ids.length > 1 || relevant && ids.length > 1);
    const fallback = DISTRIBUTION.test(q) && cube.dimensions.some((other) => DISTRIBUTION.test(other.name))
      ? distributionDefault(d, q) : d.default_member_id;
    const chosen = ids.length === 1 && relevant ? ids[0]! : relevant && jevMember ? jevMember.id : fallback;
    let use: DimensionSel["use"] = !multiple ? "fixed"
      : distribution && !cues.range && !/\b(?:over time|trend)\b/i.test(q) || cube.kind === "snapshot" || cues.latest || cues.time.from !== undefined && cues.time.from === cues.time.to ||
        ["bar", "stacked_bar", "stacked_bar_100", "pie", "table"].includes(cues.requestedChart ?? "") ? "x" : "series";
    let members: MemberSel = use === "fixed" ? { eq: chosen } : geoRole ?? { in: ids.length ? ids : [chosen] };
    const proxies = d.role === "geography" && !cues.groups &&
      !/\b(?:sum|combined total|add up|ratio)\b/i.test(q) &&
      !/\b(?:provinces?\s+only|only\s+provinces?|exclud(?:e|ing)\s+territories)\b/i.test(q) &&
      ["provinces", "provinces_and_territories", "territories"].includes(geo)
      ? territoryProxies(d) : [];
    if (proxies.length && geoRole)
      members = { in: [...d.members.filter((member) => geo === "territories"
        ? member.roles.includes("territory")
        : member.roles.some((role) => role === "province" || role === "territory")).map((member) => member.id),
      ...proxies.map((member) => member.id)] };
    const additive = cube.unit_families.length > 0 && cube.unit_families.every((family) => ADDITIVE_FAMILIES.has(family));
    let groups: DimensionSel["groups"];
    if (d.role === "geography" && !cues.groups && additive && /\bprovinces?\s+(?:vs|versus|and)\s+territories\b/i.test(q)) {
      groups = [{ label: "Provinces", members: { role: "province" } }, { label: "Territories", members: { role: "territory" } }];
      members = { not: { all: true } };
      use = cube.kind === "snapshot" || cues.latest || cues.time.from !== undefined && cues.time.from === cues.time.to ||
        ["bar", "stacked_bar", "stacked_bar_100", "pie", "table"].includes(cues.requestedChart ?? "") ? "x" : "series";
    } else if (d.role === "geography" && additive && geoRole && /\b(?:sum|combined total|add up)\b/i.test(q)) {
      use = "sum";
      members = geoRole;
    }
    dims[String(d.id)] = { use, members, ...(groups ? { groups } : {}) };
    const deterministic = Boolean(geoRole || broad.length || breakdown.length > 1 || rent || passengerCar || measure.length ||
      namedMembers.length > 0 && !semanticMembers.length);
    step(steps, `${prefix}.members`, JSON.stringify(dims[String(d.id)]), deterministic ? "rule" : relevant && Object.keys(answers).length ? "jev" : "default",
      deterministic ? null : fixed.confidence);
  }
  if (cube.family === "census_2021") {
    snapshotDimensions(cube, q, dims, cues);
    for (const entry of steps) {
      const id = /^d(\d+)\.members$/.exec(entry.question)?.[1];
      if (id && entry.answer !== JSON.stringify(dims[id])) {
        entry.answer = JSON.stringify(dims[id]);
        entry.source = "rule";
        entry.confidence = null;
      }
    }
  }
  if (cues.groups) {
    const geo = cube.dimensions.find((dimension) => dimension.role === "geography");
    const groups = selectedGroups(cube, cues);
    if (geo && groups?.length) {
      dims[String(geo.id)] = {
        use: cube.kind === "snapshot" || cues.latest || cues.time.from !== undefined && cues.time.from === cues.time.to ||
          ["bar", "stacked_bar", "stacked_bar_100", "pie", "table"].includes(cues.requestedChart ?? "") ? "x" : "series",
        members: { not: { all: true } }, groups,
      };
      const recorded = steps.find((entry) => entry.question === `d${geo.id}.members`);
      if (recorded) {
        recorded.answer = JSON.stringify(dims[String(geo.id)]);
        recorded.source = "rule";
        recorded.confidence = null;
      }
    }
  }
  if (!cues.groups && (["provinces", "provinces_and_territories", "territories"].includes(cues.geography) ||
    cues.places.some((place) => TERRITORY_CAPITALS.some((territory) => territory.name === place)))) {
    const geo = cube.dimensions.find((dimension) => dimension.role === "geography");
    const selection = geo && dims[String(geo.id)];
    const ids = selection && ("in" in selection.members ? selection.members.in :
      "eq" in selection.members ? [selection.members.eq] : []);
    const proxies = geo && selection?.use !== "sum" && ids
      ? territoryProxies(geo).filter((member) => ids.includes(member.id)) : [];
    if (proxies?.length) {
      const capitals = proxies.map((member) => member.label.split(",")[0]!);
      const territory = TERRITORY_CAPITALS.find((item) => item.code === proxies[0]!.place_id?.slice(9, 11))!;
      const message = proxies.length === 1
        ? `${territory.name} is shown by its ${territory.capital === capitals[0] ? "capital city" : "only published city"} (${capitals[0]}); this table does not publish a territory total.`
        : `Territories are shown by their ${proxies.every((member) =>
          TERRITORY_CAPITALS.some((item) => item.capital === member.label.split(",")[0])) ? "capital city" : "published city"} (${capitals.join(", ")}); this table does not publish territory totals.`;
      step(steps, "territory_proxy", message, "rule");
    }
  }
  return { dims, steps };
}

async function attachView(db: Db, result: PlanResult, origin?: string): Promise<PlanResult> {
  if (!result.spec) return result;
  try {
    const outcome = await runView(db, result.spec, { origin });
    if (outcome.kind === "ok") return { ...result, view: { ...outcome.result, warnings: [
      ...outcome.result.warnings, ...result.steps.filter((s) => s.question === "member_not_found")
        .map((s) => ({ code: "member_not_found" as const, message: s.answer })),
      ...result.steps.filter((s) => s.question === "chart_warning")
        .map((s) => ({ code: "chart_fallback" as const, message: s.answer })),
      ...result.steps.filter((s) => s.question === "group_missing")
        .map((s) => ({ code: "group_missing" as const, message: s.answer })),
      ...result.steps.filter((s) => s.question === "substituted_geography")
        .map((s) => ({ code: "substituted_geography" as const, message: s.answer })),
      ...result.steps.filter((s) => s.question === "territory_proxy")
        .map((s) => ({ code: "territory_proxy" as const, message: s.answer })),
    ] } };
    return { ...result, status: "no_match", spec: undefined, alternatives: [],
      steps: [...result.steps, { question: "validation", answer: outcome.error, confidence: null, source: "rule" }] };
  } catch { /* An unavailable view engine must not turn a planner answer into a 500. */ }
  return result;
}

async function produce(db: Db, input: string, signal?: AbortSignal): Promise<PlanResult> {
  let q = input;
  const start = performance.now();
  const steps: PlanStep[] = [];
  const result = (status: PlanResult["status"], planner: PlanResult["planner"], spec?: ViewSpec,
    alternatives: PlanResult["alternatives"] = [], reason?: string): PlanResult =>
    ({ status, q: input, spec, alternatives, ...(reason ? { reason } : {}), steps, planner,
      ms: Math.round(performance.now() - start), build_id: db.manifest.build_id, normalized_build_id: db.normalized.build_id });
  if (words(q).join("").length < 2) { step(steps, "enough", "false", "rule"); return result("need_more", "rule"); }
  q = normalizeKnownWords(q.replace(/\bcauses?\s+of\s+death\b/gi, "deaths by cause"));
  const cues = parseCues(q);
  if (cues.physiographic) {
    const reason = `The ${cues.physiographic.label} does not follow province borders; no Statistics Canada table publishes it as a province group.`;
    step(steps, "region", reason, "rule");
    return result("no_match", "rule", undefined, [], reason);
  }
  const directPid = tablePid(q);
  const vector = q.match(/^v\d+$/i);
  let direct: CubeInfo | undefined;
  let vectorIds: Record<string, DimensionSel> | undefined;
  if (directPid) direct = await getCube(db, directPid);
  if (vector) {
    const row = await db.one("SELECT * FROM series WHERE vector = $1 LIMIT 1", [q.toLowerCase()]);
    if (row) {
      direct = await getCube(db, String(row.pid));
      if (direct) vectorIds = Object.fromEntries(direct.dimensions.map((d) => [d.id, { use: "fixed", members: { eq: Number(row[`member_id_${d.id}`]) } }]));
    }
  }
  if (direct) {
    const spec = headline(direct);
    if (vectorIds) spec.layers[0]!.dims = vectorIds;
    step(steps, vector ? "vector" : "table_number", direct.pid, "rule");
    for (const [id, selected] of Object.entries(spec.layers[0]!.dims)) step(steps, `d${id}.members`, JSON.stringify(selected), "rule");
    step(steps, "time", JSON.stringify(spec.time), "default");
    step(steps, "chart", spec.chart.type, "default");
    step(steps, "transform", spec.transform, "default");
    const validation = await runView(db, spec);
    if (validation.kind === "invalid") {
      step(steps, "validation", validation.error, "rule");
      return result("no_match", "rule");
    }
    return result("ok", "rule", spec);
  }
  if (directPid || vector) { step(steps, "table", "not found in build", "rule"); return result("no_match", "rule"); }
  q = withoutTime(q);
  const locative = /\b(?:in|for|near|around|of|vs\.?|versus|with)\s+(?:the\s+)?[\p{L}]/iu.test(q);
  const prefix = !locative && !cues.places.length && cues.geography === "one"
    ? q.match(/^([\p{L}][\p{L}'-]{3,})\s+[\p{L}]/u)?.[1] : undefined;
  if (/\bcensus\b/i.test(q) ||
    (!cues.places.length || /\b(?:vs\.?|versus|compared (?:to|with)|and)\b/i.test(q)) && locative || prefix) {
    const found = await censusPlaces(db, q, Boolean(prefix && !/\bcensus\b/i.test(q)));
    if (found.length && (!prefix || !lexicalConcept(prefix))) {
      const places = new Map<string, string>();
      for (const place of [...cues.places, ...found]) {
        const key = place.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
        if (!places.has(key)) places.set(key, place);
      }
      cues.places = orderMembersByQuery(q, [...places.values()].map((label) => ({ label }))).map(({ label }) => label);
      if (cues.geography === "one") cues.geography = "listed";
    }
  }
  let topic = withoutPlaces(q, cues.places);
  if (cues.groups) {
    for (const term of cues.groupTerms ?? [])
      topic = topic.replace(new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), " ");
    topic = topic.replace(/\b(?:vs\.?|versus|compared (?:to|with)|and|by region)\b/gi, " ")
      .replace(/[,.:]+/g, " ").replace(/\s+/g, " ").trim();
    cues.places = [];
    cues.concepts = [topic];
  } else cues.concepts = cues.concepts.length === 1 ? [topic] : topic.split(PARTS).filter((part) => words(part).length > 0);
  const hasKey = Boolean(process.env.TYPESAFE_API_KEY);
  let planner: PlanResult["planner"] = hasKey ? "jev" : "heuristic";
  let concept: CatalogConcept | undefined;
  if (hasKey) try {
    const answers = await askJev(cues.places.length === 1 && !cues.range
      ? { q, topic, places: cues.places } : { q: topic }, conceptQuestion(), signal);
    const chosen = choice(answers, "concept");
    concept = CONCEPTS.find((entry) => entry.id === chosen.value);
    const headlineGrowth = /\b(?:growth|grow|grew|grown)\b/i.test(q) &&
      !/\b(?:components?|drivers?|sources?|births?|deaths?|migration|immigrants?)\b/i.test(q);
    if (headlineGrowth && /\bpopulation\b/i.test(q))
      concept = CONCEPTS.find((entry) => entry.id === "population_growth_rate");
    else if (headlineGrowth && /\b(?:gdp|gross domestic product)\b/i.test(q))
      concept = CONCEPTS.find((entry) => entry.id === "gdp_growth_rate");
    if (concept?.id.startsWith("census_") && !/\bcensus\b/i.test(q)) {
      const alternative = lexicalConcept(topic);
      const alternativeScore = alternative ? titleScore(alternative.label, topic) : 0;
      const censusScore = titleScore(concept.label, topic);
      const needed = Math.min(2, words(topic).length);
      if (alternative?.pids.some((pid) => db.info.get(pid)?.family === "wds") &&
        alternativeScore > 0 &&
        (cues.range || !/\b(?:by|breakdown|distribution|detailed)\b/i.test(topic) &&
          alternativeScore >= censusScore) &&
        (await Promise.all(alternative.pids.filter((pid) => db.info.get(pid)?.family === "wds")
          .map((pid) => getCube(db, pid)))).some((cube) => cube &&
          (cues.range && alternativeScore > censusScore ||
            matches(cube.title, topic) >= needed ||
            cube.dimensions.some((d) => d.members.some((member) =>
              matches(member.label, topic) >= needed))) &&
          cues.places.every((place) => cube.dimensions.some((d) => d.role === "geography" &&
            d.members.some((member) => geographyMatch(member, place))))))
        concept = alternative;
    }
    step(steps, "concept", concept?.id ?? "none", concept?.id === chosen.value ? "jev" : "rule",
      concept?.id === chosen.value ? chosen.confidence : null);
    if (chosen.value === "none" && chosen.confidence >= 0.6 && !lexicalConcept(topic))
      return result("no_match", planner);
  } catch (error) {
    if (signal?.aborted) throw error;
    planner = "heuristic";
  }
  if (planner === "heuristic" && !concept) concept = lexicalConcept(topic);
  const language = /\b(?:languages?|speakers?|speak|speaks|spoken|mother tongue)\b/i.test(topic);
  const languageConcept = /\bmother tongue|first language\b/i.test(topic) ? "census_mother_tongue"
    : /\b(?:at home|home languages?)\b/i.test(topic) ? "census_home_language"
      : /\b(?:english|french|official|bilingual)\b/i.test(topic) ? "census_official_languages" : "census_home_language";
  const override = WORK_TRAVEL.test(topic) ? "census_commuting_mode"
    : CAR_SALES.test(topic) && !/\b(?:dealers?|retail|industr(?:y|ies)|stores?)\b/i.test(topic) ? "vehicle_sales"
      : language ? languageConcept : undefined;
  if (override && concept?.id !== override) {
    concept = CONCEPTS.find((entry) => entry.id === override);
    const recorded = steps.find((entry) => entry.question === "concept");
    if (recorded) { recorded.answer = override; recorded.source = "rule"; recorded.confidence = null; }
  }
  // A named city's category breakdown needs a table for that subject, not one
  // that merely has the category as a secondary dimension (e.g. income by age).
  if (!cues.range && cues.places.some((place) => place !== "Canada" && !PROVINCE_TERRITORY_NAMES.has(place)) &&
    /\b(?:by|breakdown|distribution|groups?|profile)\b/i.test(topic)) {
    const local = lexicalConcept(topic, true);
    if (local && local !== concept &&
      (!concept?.id.startsWith("census_") || matches(local.label, topic) > matches(concept.label, topic)) &&
      (await Promise.all(local.pids.filter((pid) => db.info.get(pid)?.family === "census_2021")
        .map((pid) => getCube(db, pid)))).some((cube) => cube && supports(cube, q, cues)) &&
      (!concept || concept.id.startsWith("census_") ||
        !(await Promise.all(concept.pids.map((pid) => getCube(db, pid))))
          .some((cube) => cube && supports(cube, q, cues)))) {
      concept = local;
      const recorded = steps.find((entry) => entry.question === "concept");
      if (recorded) { recorded.answer = local.id; recorded.source = "rule"; recorded.confidence = null; }
    }
  }
  if (concept?.id.startsWith("census_") && cues.places.length >= 2 && cues.places.length <= 3 &&
    /\b(?:vs\.?|versus|compared (?:to|with)|and)\b/i.test(q)) cues.concepts = [topic];
  const partConcepts = cues.concepts.length > 1 ? cues.concepts.map((part) => lexicalConcept(part)) : [];
  const list = await candidates(db, topic, cues, concept, partConcepts);
  let answers: Answers = {};
  if (hasKey) try {
    answers = await askJev({ q, cues, concept, candidates: list.map(({ cube }, i) => preview(cube, q, i)) }, {
      ...initialQuestions(list, concept),
      ...(list.length ? {} : { table: { type: "choice", instructions: "No queryable tables exist in this build.", criteria: { none: "No matching table." } } }),
    }, signal);
    planner = "jev";
  } catch (error) {
    if (signal?.aborted) throw error;
    planner = "heuristic";
  }
  if (planner === "jev") {
    step(steps, "enough", String(probability(answers, "enough")), "jev", probability(answers, "enough"));
    step(steps, "related", String(probability(answers, "related")), "jev", probability(answers, "related"));
    if (probability(answers, "related") < 0.3) return result("no_match", planner);
    if (probability(answers, "enough") < 0.35 && words(q).length < 3) return result("need_more", planner);
  }
  if (!list.length) return result("no_match", planner);
  const tableChoice = choice(answers, "table");
  if (tableChoice.value === "none" && tableChoice.confidence >= 0.6 && !list.some(({ cube }) => covers(cube, q)))
    return result("no_match", planner);
  const index = /^t\d+$/.test(tableChoice.value) ? Number(tableChoice.value.slice(1)) : -1;
  const selected = list[index];
  const catalogOptions = concept?.pids.flatMap((pid) => {
    const candidate = list.find(({ cube }) => cube.pid === pid && supports(cube, q, cues));
    return candidate ? [candidate] : [];
  }) ?? [];
  const namedProvince = cues.places.some((place) => catalogOptions.some(({ cube }) =>
    cube.dimensions.some((d) => d.role === "geography" && d.members.some((m) =>
      (m.roles.includes("province") || m.roles.includes("territory")) &&
      m.label.toLowerCase() === place.toLowerCase()))));
  const namedRegion = !namedProvince || /\b(?:city|cma|census subdivision|municipalit(?:y|ies))\b/i.test(q)
    ? catalogOptions.find(({ cube }) => cube.family === "census_2021" &&
      cube.dimensions.some((d) => d.role === "geography" && censusGeoMembers(d, q).some((m) =>
        m.place_id?.slice(5, 9) === "0503" || m.place_id?.slice(5, 9) === "0504" ||
        m.place_id?.slice(5, 9) === "0005")))
    : undefined;
  const catalogChoice = namedRegion ?? catalogOptions[0];
  const leading = partConcepts[0]?.pids.map((pid) => list.find(({ cube }) => cube.pid === pid &&
    supports(cube, q, cues) && covers(cube, cues.concepts[0]!))).find((candidate) => candidate) ??
    (cues.concepts.length > 1 ? list.find(({ cube, active }) =>
      active && supports(cube, q, cues) && covers(cube, cues.concepts[0]!)) ??
      list.find(({ cube }) => supports(cube, q, cues) && covers(cube, cues.concepts[0]!)) : undefined);
  const industry = /\b(?:by|across|each) industr(?:y|ies)\b/i.test(q) && cues.geography === "one" && concept
    ? concept.pids.map((pid) => list.find(({ cube }) => cube.pid === pid && supports(cube, q, cues) &&
        cube.dimensions.some((d) => /\bNAICS\b/i.test(d.name)))).find((candidate) => candidate) : undefined;
  const validSelection = selected && supports(selected.cube, q, cues) &&
    (!concept || concept.pids.includes(selected.cube.pid) || !catalogChoice && covers(selected.cube, concept.label));
  const fallback = list.find(({ cube }) => supports(cube, q, cues) && (!concept || covers(cube, concept.label)));
  const censusSummary = catalogChoice && selected && catalogChoice.cube.family === "census_2021" &&
    selected.cube.family === "census_2021" &&
    catalogChoice.cube.title.split(":")[0] === selected.cube.title.split(":")[0] ? catalogChoice : undefined;
  const proposed = leading && (!selected || !validSelection || !covers(selected.cube, cues.concepts[0]!)) ? leading
    : industry ?? censusSummary ?? (validSelection ? selected : catalogChoice ?? fallback);
  const current = list.find((item) => item.active && supports(item.cube, q, cues) &&
    (!concept || concept.pids.includes(item.cube.pid) || covers(item.cube, concept.label)) &&
    (concept?.pids.includes(item.cube.pid) || item.titleScore >= Math.max(1, (proposed?.titleScore ?? 1) - 1)));
  const trend = cues.range || /\b(?:over time|trend|monthly|quarterly|annually|year by year)\b/i.test(q);
  const wdsTrend = trend && concept?.pids
    ? list.find((item) => item.active && item.cube.family === "wds" && concept.pids.includes(item.cube.pid) &&
      supports(item.cube, q, cues)) : undefined;
  let primary: Candidate | undefined = wdsTrend || (proposed?.active ? proposed : current ?? proposed);
  if (leading && cues.concepts.length > 1 &&
    !cues.concepts.every((part) => primary && covers(primary.cube, part))) primary = leading;
  if (!primary && cues.places.length >= 2 && /\b(?:vs\.?|versus|compared (?:to|with)|and)\b/i.test(q)) {
    const partial = list.filter(({ cube }) => supports(cube, q, cues, true));
    primary = concept?.pids.map((pid) => partial.find(({ cube }) => cube.pid === pid)).find((item) => item) ??
      partial.find(({ cube }) => covers(cube, concept?.label ?? topic) || covers(cube, topic)) ??
      (!/\b(?:cpi|inflation|index|rate|growth|share)\b/i.test(q)
        ? partial.find(({ cube }) => words(topic).some((term) =>
          words(cube.title).some((word) => word === `${term}s` || term === `${word}s`))) : undefined);
  }
  if (!primary && concept?.id.startsWith("census_") && cues.places.length)
    primary = concept.pids.map((pid) => list.find(({ cube }) => cube.pid === pid && cube.family === "census_2021"))
      .find((item) => item);
  if (concept?.id === "vehicle_sales" && primary && !concept.pids.includes(primary.cube.pid)) primary = undefined;
  if (primary && cues.groups) {
    const required = cues.groups.filter((group) => !cues.byRegion || group.label !== "Territories");
    const complete = (cube: CubeInfo) => required.every((group) =>
      groupCoverage(cube, group) >= (group.region?.members.length ?? 1));
    if (!complete(primary.cube)) {
      const frequency = primary.cube.frequency;
      const whole = list.find((item) => item.active && item.cube.frequency === frequency &&
        supports(item.cube, topic, cues) && covers(item.cube, topic) && complete(item.cube));
      if (whole) primary = whole;
    }
  }
  if (!primary) { step(steps, "table", "No table covers the requested concept and geography", "rule"); return result("no_match", planner); }
  const primaryCube = primary.cube;
  step(steps, "table", primary.cube.pid, planner === "jev" && selected === primary ? "jev" : "rule",
    planner === "jev" && selected === primary ? tableChoice.confidence : null);
  const other: Candidate[] = [];
  const primaryCensusSubject = primary.cube.family === "census_2021" ? primary.cube.title.split(":")[0] : undefined;
  if (cues.concepts.length > 1) for (const [partIndex, part] of cues.concepts.entries()) {
    if (covers(primary.cube, part)) continue;
    const partConcept = partConcepts[partIndex];
    const priority = (item: Candidate) => {
      const index = partConcept?.pids.indexOf(item.cube.pid) ?? -1;
      return index < 0 ? Infinity : index;
    };
    const eligible = list.filter((item) => item !== primary && covers(item.cube, part) && !other.includes(item) &&
      !(primaryCensusSubject && item.cube.family === "census_2021" &&
        primaryCensusSubject === item.cube.title.split(":")[0]))
      .sort((a, b) => priority(a) - priority(b) ||
        titleScore(b.cube.title, part) - titleScore(a.cube.title, part) ||
        Number(b.cube.frequency === primaryCube.frequency) - Number(a.cube.frequency === primaryCube.frequency) ||
        probability(answers, `t${list.indexOf(b)}.needed`) - probability(answers, `t${list.indexOf(a)}.needed`));
    const extra = eligible[0];
    const needed = extra ? probability(answers, `t${list.indexOf(extra)}.needed`) : 0;
    const explicitConcept = extra && cues.concepts.length > 1 && Boolean(partConcept?.pids.includes(extra.cube.pid) || titleScore(extra.cube.title, part) >= 2);
    if (extra && (planner !== "jev" || needed > 0.5 || explicitConcept)) {
      other.push(extra);
      step(steps, "table.needed", extra.cube.pid, explicitConcept || planner !== "jev" ? "rule" : "jev",
        explicitConcept || planner !== "jev" ? null : needed);
    }
    if (other.length >= cues.concepts.length - 1) break;
  }
  const layers = [primary, ...other];
  const groupScopes = new Map<string, GroupTarget[]>();
  const methodDifferences = new Map<string, string>();
  if (cues.groups) for (const group of cues.groups) {
    if (cues.byRegion && group.label === "Territories" ||
      layers.some(({ cube }) => groupCoverage(cube, group) >= (group.region?.members.length ?? 1))) continue;
    const root = primaryCube.title.split(/,|\s+by\s+/i)[0]!;
    const search = await db.search(`${root} ${group.region?.label ?? group.place ?? ""}`, { ...opts, limit: 20 })
      .catch(() => ({ rows: [] as Row[] }));
    const found = await Promise.all(search.rows.filter((row) =>
      db.info.get(String(row.pid))?.family === primaryCube.family &&
      String(row.title_en).toLowerCase().startsWith(root.toLowerCase()))
      .map((row) => getCube(db, String(row.pid))));
    const matches = [...list, ...found.flatMap((cube) => cube ? [{ cube, titleScore: titleScore(cube.title, topic), active: true }] : [])]
      .filter((item, index, entries) => entries.findIndex((entry) => entry.cube.pid === item.cube.pid) === index &&
        item.cube.pid !== primaryCube.pid && item.cube.family === primaryCube.family &&
        groupCoverage(item.cube, group) > 0 && supports(item.cube, topic, cues) &&
        item.cube.title.toLowerCase().startsWith(root.toLowerCase()) &&
        primaryCube.dimensions.filter((dimension) => dimension.role === "measure").every((dimension) => {
          const requested = requestedMeasure(dimension, q).map((id) =>
            dimension.members.find((member) => member.id === id)?.label);
          return !requested.length || item.cube.dimensions.some((candidate) =>
            candidate.role === "measure" && requested.every((label) =>
              candidate.members.some((member) => member.label === label)));
        }))
      .sort((a, b) =>
        Number(groupCoverage(b.cube, group) >= (group.region?.members.length ?? 1)) -
        Number(groupCoverage(a.cube, group) >= (group.region?.members.length ?? 1)) ||
        Number(b.cube.frequency === primaryCube.frequency) - Number(a.cube.frequency === primaryCube.frequency) ||
        b.titleScore - a.titleScore);
    const sibling = matches[0];
    if (!sibling || layers.length === 4) {
      step(steps, "group_missing", `${group.label} is unavailable in tables for ${topic}`, "rule");
      continue;
    }
    if (!layers.some((layer) => layer.cube.pid === sibling.cube.pid)) {
      layers.push(sibling);
      step(steps, "table.needed", `${sibling.cube.pid} for ${group.label}`, "rule");
    }
    groupScopes.set(sibling.cube.pid, [...(groupScopes.get(sibling.cube.pid) ?? []), group]);
    const siblingMovingAverage = /three-month moving average/i.test(sibling.cube.title);
    const primaryMovingAverage = /three-month moving average/i.test(primaryCube.title);
    if (siblingMovingAverage !== primaryMovingAverage) {
      const primaryGroups = cues.groups.filter((candidate) =>
        ![...groupScopes.values()].some((scope) => scope.includes(candidate))).map((candidate) => candidate.label).join(", ") || "Other groups";
      const method = (cube: CubeInfo, movingAverage: boolean) =>
        movingAverage ? "3-month moving average" : cube.frequency?.toLowerCase() ?? "published series";
      const message = `${group.label}: ${method(sibling.cube, siblingMovingAverage)} (${tableNumber(sibling.cube.pid)}); ` +
        `${primaryGroups}: ${method(primaryCube, primaryMovingAverage)} (${tableNumber(primaryCube.pid)}).`;
      step(steps, "group_method", message, "rule");
      methodDifferences.set(sibling.cube.pid, message);
    }
  }
  const layerCues = ({ cube }: Candidate): Cues => cues.groups ? { ...cues,
    groups: groupScopes.get(cube.pid) ?? (cube.pid === primaryCube.pid
      ? cues.groups.filter((group) => ![...groupScopes.values()].some((assigned) => assigned.includes(group)))
      : cues.groups) } : cues;
  const layerDimensions = (candidate: Candidate, useJev: boolean) => {
    const part = layers.length > 1 && cues.concepts.length > 1
      ? cues.concepts.find((term) => covers(candidate.cube, term)) ?? q : q;
    return dimensions(candidate.cube, part, part === q ? layerCues(candidate)
      : { ...layerCues(candidate), concepts: [part] }, signal, useJev);
  };
  let selections: { dims: Record<string, DimensionSel>; steps: PlanStep[] }[];
  if (planner === "jev") try {
    selections = await Promise.all(layers.map((candidate) => layerDimensions(candidate, true)));
  } catch (error) {
    if (signal?.aborted) throw error;
    planner = "heuristic";
    selections = await Promise.all(layers.map((candidate) => layerDimensions(candidate, false)));
  }
  else selections = await Promise.all(layers.map((candidate) => layerDimensions(candidate, false)));
  for (const s of selections) steps.push(...s.steps);
  {
    const geo = primary.cube.dimensions.find((d) => d.role === "geography");
    const available = cues.places.some((place) => geo && geographyForPlace(geo, place));
    for (const place of cues.places) if (!geo || !geographyForPlace(geo, place))
      step(steps, "member_not_found", `Geography ${place} is not available in table ${primary.cube.pid}; ` +
        (available ? "showing available places only" : "showing Canada"), "rule");
  }
  for (const [re, label] of MEMBER_TERMS) if ((!WORK_TRAVEL.test(q) || label !== "Employment") &&
    re.test(q) && !layers.some(({ cube }) =>
    cube.title.toLowerCase().includes(label.toLowerCase()) ||
    label === "Rented accommodation" && /\brents?\b/i.test(cube.title) ||
    cube.dimensions.some((d) => d.members.some((m) => termMember(m, label, q))))) {
    step(steps, "member_not_found", `${label} not in this table`, "rule");
  }
  let time: TimeWindow;
  if (cues.relativeMonths && primary.cube.period_max) {
    const date = new Date(`${primary.cube.period_max.slice(0, 7)}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - cues.relativeMonths);
    time = { preset: "max", from: date.toISOString().slice(0, 7) };
  } else {
    const shortAnnual = primary.cube.frequency === "Annual" && primary.cube.period_min && primary.cube.period_max &&
      Number(primary.cube.period_max.slice(0, 4)) - Number(primary.cube.period_min.slice(0, 4)) < 4;
    time = cues.range || cues.latest || cues.time.from || cues.time.to || cues.fullHistory ? cues.time
      : { preset: shortAnnual ? "max" : "5Y" };
  }
  if (primary.cube.kind === "snapshot") time = { preset: "latest" };
  const commonStart = layers.length > 1 ? layers.map(({ cube }) => cube.period_min).filter((date): date is string => Boolean(date)).sort().at(-1) : undefined;
  if (commonStart && time.from && time.from < commonStart) time = { ...time, from: commonStart.slice(0, 10) };
  const firstDims = selections[0]!.dims;
  const xDims = primary.cube.dimensions.filter((d) => firstDims[String(d.id)]?.use === "x");
  if (xDims.length > 1) for (const d of xDims.slice(1)) firstDims[String(d.id)]!.use = "series";
  const chartChoice = choice(answers, "chart");
  let chart: ChartType = cues.requestedChart && cues.requestedChart !== "pie" && cues.requestedChart !== "table"
    ? cues.requestedChart : xDims.length || primary.cube.kind === "snapshot" || cues.latest ? "bar" : "line";
  if (!cues.requestedChart && cues.chart && xDims.length) chart = cues.chart;
  if (xDims.length && !["bar", "stacked_bar", "stacked_bar_100"].includes(chart)) {
    step(steps, "chart_warning", "A single-period category selection cannot display the requested time-axis chart; showing bars.", "rule");
    chart = "bar";
  }
  if (cues.requestedChart === "pie" || cues.requestedChart === "table")
    step(steps, "chart_warning", `${cues.requestedChart === "pie" ? "Pie charts" : "Table charts"} are not supported; showing category bars instead${cues.requestedChart === "table" ? " (values remain available in the Table panel)" : ""}.`, "rule");
  const seriesDims = primary.cube.dimensions.filter((d) => firstDims[String(d.id)]?.use === "series");
  const seriesCount = seriesDims.reduce((n, d) => n * memberCount(d, firstDims[String(d.id)]!), 1);
  if (!xDims.length && !cues.requestedChart && chart === "line" && seriesCount > 13) {
    const largest = seriesDims.sort((a, b) =>
      memberCount(b, firstDims[String(b.id)]!) - memberCount(a, firstDims[String(a.id)]!))[0];
    if (largest) {
      firstDims[String(largest.id)]!.use = "x";
      chart = "bar";
      step(steps, "chart_reason", `${seriesCount} series would obscure the trend; showing the latest category bars instead.`, "rule");
    }
  }
  const hasX = primary.cube.dimensions.some((d) => firstDims[String(d.id)]?.use === "x");
  if (hasX && !cues.range && !cues.time.from && !cues.time.to) time = { preset: "latest" };
  step(steps, "time", JSON.stringify(time), "rule");
  let transform: Transform = cues.transform ?? "level";
  // Table inventories include every measure's units; the view resolves the selected series' units.
  if (primary.cube.family === "census_2021" && layers.length === 1)
    transform = cues.transform === "share_of_x" ? "share_of_x" : "level";
  if (hasX && transform === "pct_change_yoy" && cues.transform === "pct_change_yoy" && chart === "bar" &&
    !cues.latest && (cues.range || cues.time.preset !== "latest")) transform = "pct_change_window";
  if (transform === "share_of_x" && !hasX) transform = "level";
  if (chart.startsWith("stacked") && (transform !== "level" && transform !== "share_of_x" ||
    layers.some(({ cube }) => !cube.unit_families.length || cube.unit_families.some((family) => !ADDITIVE_FAMILIES.has(family))))) {
    step(steps, "chart_warning", "Stacking non-additive or transformed values would mislead; showing unstacked values.", "rule");
    chart = chart === "stacked_area" ? "area" : "bar";
  }
  step(steps, "chart", chart, "rule", chart === chartChoice.value ? chartChoice.confidence : null);
  step(steps, "transform", transform, "rule");
  const layerOrder = layers.map((_, index) => index);
  if (layerOrder.length > 1 && cues.concepts.length > 1) {
    const ranks = layers.map(({ cube }) => {
      const index = cues.concepts.findIndex((part) => covers(cube, part));
      return index < 0 ? cues.concepts.length : index;
    });
    layerOrder.sort((a, b) => ranks[a]! - ranks[b]!);
  }
  let spec = ViewSpec.parse({ v: SPEC_VERSION, layers: layerOrder.map((index) => ({ pid: layers[index]!.cube.pid,
    ...(methodDifferences.has(layers[index]!.cube.pid) ? { method_difference: methodDifferences.get(layers[index]!.cube.pid) } : {}),
    dims: selections[index]!.dims })),
    time, chart: { type: chart, ...(cues.horizontal !== undefined ? { horizontal: cues.horizontal } : {}) },
    transform, ...(transform === "index_first" && cues.indexBase ? { index_base: cues.indexBase } : {}) });
  let substitutedReason: string | undefined;
  // A shape-valid selection can still have no published observations. Try another
  // compatible table with its own dimensions instead of returning a blank chart.
  const usable = (outcome: ViewOutcome) => outcome.kind === "ok" &&
    outcome.result.series.some((series) => series.points.some((point) => point[2] !== null));
  try {
    let check = await runView(db, spec);
    if (usable(check) && check.kind === "ok" && primary.cube.frequency === "Annual" &&
      spec.time.preset === "5Y" && !cues.range && !cues.latest) {
      const shown = new Set(check.result.series.flatMap((series) =>
        series.points.filter((point) => point[2] !== null).map((point) => point[1])));
      if (shown.size < 5) {
        const allSpec = { ...spec, time: { preset: "max" as const } };
        const all = await runView(db, allSpec);
        if (usable(all) && all.kind === "ok" && new Set(all.result.series.flatMap((series) =>
          series.points.filter((point) => point[2] !== null).map((point) => point[1]))).size < 5) {
          spec = allSpec;
          check = all;
          const timeStep = steps.find((s) => s.question === "time");
          if (timeStep) timeStep.answer = JSON.stringify(spec.time);
        }
      }
    }
    if (usable(check) && check.kind === "ok") {
      if (!cues.requestedChart && !cues.latest && !hasX && chart === "line" &&
        new Set(check.result.series.flatMap((series) =>
          series.points.filter((point) => point[2] !== null).map((point) => point[1]))).size === 1) {
        const dimension = seriesDims[0];
        if (dimension) spec.layers[0]!.dims[String(dimension.id)]!.use = "x";
        if (!cues.time.from && !cues.time.to) spec.time = { preset: "latest" };
        spec.chart.type = "bar";
        chart = "bar";
        step(steps, "chart_reason", "Only one published period is available for this selection; showing latest bars.", "rule");
        const chartStep = steps.find((s) => s.question === "chart");
        if (chartStep) chartStep.answer = chart;
        const timeStep = steps.find((s) => s.question === "time");
        if (timeStep) timeStep.answer = JSON.stringify(spec.time);
      }
      if (!cues.requestedChart && !hasX && cues.time.from && cues.time.from === cues.time.to) {
        const last = check.result.series.flatMap((series) =>
          series.points.filter((point) => point[2] !== null).map((point) => point[1])).sort().at(-1);
        if (last) {
          spec.time = { preset: "max", from: last, to: last };
          chart = "bar";
          spec.chart.type = chart;
          const chartStep = steps.find((s) => s.question === "chart");
          if (chartStep) chartStep.answer = chart;
          const timeStep = steps.find((s) => s.question === "time");
          if (timeStep) timeStep.answer = JSON.stringify(spec.time);
        }
      }
      if (chart.startsWith("stacked") && check.result.series.some((series) =>
        series.points.some((point) => point[2] !== null && point[2] < 0))) {
        chart = chart === "stacked_area" ? "area" : "bar";
        spec.chart.type = chart;
        step(steps, "chart_warning", "Stacking negative values would mislead; showing unstacked values.", "rule");
        const chartStep = steps.find((s) => s.question === "chart");
        if (chartStep) chartStep.answer = chart;
      }
    }
    if (usable(check) && check.kind === "ok" && cues.requestedChart === "pie" && check.result.series.some((series) =>
      series.points.some((point) => point[2] !== null && point[2] < 0))) {
      const warning = steps.find((s) => s.question === "chart_warning");
      if (warning) warning.answer = "Pie charts are unsupported and cannot represent negative values; showing category bars instead.";
    }
    if (!usable(check) && layers.length === 1) {
      // A table can publish only some combinations of adjustment and price basis.
      // Try the other named basis only if the user did not specify one.
      for (const name of ["Seasonal adjustment", "Prices"]) {
        if (name === "Seasonal adjustment" && /\b(?:seasonally adjusted|unadjusted)\b/i.test(q) ||
          name === "Prices" && /\b(?:current|constant)\s+prices\b/i.test(q)) continue;
        const dimension = primary.cube.dimensions.find((d) => d.name === name && d.members.length <= 3);
        const selection = dimension && spec.layers[0]?.dims[String(dimension.id)];
        if (!dimension || selection?.use !== "fixed" || !("eq" in selection.members)) continue;
        for (const member of dimension.members) {
          if (member.id === selection.members.eq) continue;
          const replacement = structuredClone(spec);
          replacement.layers[0]!.dims[String(dimension.id)] = { use: "fixed", members: { eq: member.id } };
          const retry = await runView(db, replacement);
          if (!usable(retry)) continue;
          spec = replacement;
          check = retry;
          const recorded = steps.find((s) => s.question === `d${dimension.id}.members`);
          if (recorded) { recorded.answer = JSON.stringify(replacement.layers[0]!.dims[String(dimension.id)]); recorded.source = "rule"; recorded.confidence = null; }
          step(steps, "validation", `Used published ${member.label} rather than an unavailable combination`, "rule");
          break;
        }
        if (usable(check)) break;
      }
    }
    if ((!usable(check) || check.kind === "ok" && check.result.series.some((series) => series.unpublished)) &&
      !/\b(?:including|excluding)\s+unclassified businesses\b/i.test(q)) {
      // The default including-unclassified total can be unpublished even when
      // another comparison layer has data. Try the matching published aggregate.
      for (const [layerIndex, layer] of spec.layers.entries()) {
        if (check.kind === "ok" && !check.result.series.some((series) =>
          series.layer === layerIndex && series.unpublished)) continue;
        const cube = layers[layerOrder[layerIndex]]!.cube;
        for (const dimension of cube.dimensions) {
          const selection = layer.dims[String(dimension.id)];
          if (selection?.use !== "fixed" || !("eq" in selection.members) ||
            selection.members.eq !== dimension.default_member_id) continue;
          const original = dimension.members.find((member) => member.id === dimension.default_member_id);
          if (!original) continue;
          const base = original.label.replace(/\b(?:including|excluding)\s+unclassified businesses\b/i, "").trim();
          if (base === original.label) continue;
          const alternate = dimension.members.find((member) => member.id !== original.id &&
            member.label.replace(/\b(?:including|excluding)\s+unclassified businesses\b/i, "").trim() === base);
          if (!alternate) continue;
          const replacement = structuredClone(spec);
          replacement.layers[layerIndex]!.dims[String(dimension.id)] = { use: "fixed", members: { eq: alternate.id } };
          const retry = await runView(db, replacement);
          if (retry.kind !== "ok" || retry.result.series.some((series) =>
            series.layer === layerIndex && series.unpublished) ||
            !retry.result.series.some((series) =>
              series.layer === layerIndex && series.points.some((point) => point[2] !== null))) continue;
          spec = replacement;
          check = retry;
          if (layerIndex === 0) {
            const recorded = steps.find((s) => s.question === `d${dimension.id}.members`);
            if (recorded) { recorded.answer = JSON.stringify(replacement.layers[0]!.dims[String(dimension.id)]); recorded.source = "rule"; recorded.confidence = null; }
          }
          step(steps, "validation", `${original.label} unpublished in ${cube.pid}; using ${alternate.label}`, "rule");
          break;
        }
      }
    }
    if (layers.length > 1 && !cues.transform && transform === "level" && check.kind === "ok") {
      const thirdAxis = check.result.warnings.some((warning) =>
        warning.code === "mixed_units" && warning.message.includes("needs a third axis"));
      const unlikeLevels = cues.concepts.length > 1 && check.result.axes.length === 2 &&
        check.result.axes.every((axis) => axis.unit_family !== "percent" && axis.unit_family !== "rate");
      if (thirdAxis || unlikeLevels) {
        const indexed = { ...spec, transform: "index_first" as const };
        const retry = await runView(db, indexed);
        if (retry.kind === "ok" && retry.result.series.some((series) =>
          series.points.some((point) => point[2] !== null))) {
          spec = indexed;
          check = retry;
          transform = "index_first";
          const recorded = steps.find((entry) => entry.question === "transform");
          if (recorded) recorded.answer = transform;
          step(steps, "transform_reason", thirdAxis ? "More than two published unit axes; indexing to show every series."
            : "Different published level units; indexing to compare growth on one axis.", "rule");
        }
      }
    }
    if (!usable(check) && check.kind === "ok" && layers.length === 1 && !cues.groups) {
      const geography = primary.cube.dimensions.find((dimension) => dimension.role === "geography");
      const selection = geography && spec.layers[0]!.dims[String(geography.id)];
      const ids = selection && "eq" in selection.members ? [selection.members.eq]
        : selection && "in" in selection.members ? selection.members.in : [];
      const members = new Map(geography?.members.map((member) => [member.id, member]) ?? []);
      const requested = ids.map((id) => typeof id === "number" ? members.get(id) :
        geography?.members.find((member) => member.label === id)).filter((member): member is CubeMember =>
        Boolean(member && cues.places.some((place) => geographyMatch(member, place))));
      const parents: CubeMember[] = [];
      for (const member of requested) {
        for (let ancestor = members.get(member.parent_id ?? -1); ancestor; ancestor = members.get(ancestor.parent_id ?? -1)) {
          const trial = structuredClone(spec);
          trial.layers[0]!.dims[String(geography!.id)] = { use: "fixed", members: { eq: ancestor.id } };
          if (usable(await runView(db, trial))) { parents.push(ancestor); break; }
        }
      }
      if (parents.length && geography && selection) {
        const replacement = structuredClone(spec);
        const xChosen = Object.values(replacement.layers[0]!.dims).some((dimension) => dimension.use === "x");
        replacement.layers[0]!.dims[String(geography.id)] = {
          use: selection.use === "x" || !xChosen && ["bar", "stacked_bar", "stacked_bar_100"].includes(chart) ? "x" : "series",
          members: { in: [...new Set([...ids, ...parents.map((member) => member.id)])] },
        };
        const retry = await runView(db, replacement);
        if (usable(retry)) {
          spec = replacement;
          check = retry;
          const category = primary.cube.dimensions.filter((dimension) => dimension.role !== "geography")
            .map((dimension) => {
              const selected = spec.layers[0]!.dims[String(dimension.id)];
              const memberRef = selected?.use === "fixed" && "eq" in selected.members ? selected.members.eq : undefined;
              return memberRef !== undefined && memberRef !== dimension.default_member_id
                ? dimension.members.find((member) => member.id === memberRef || member.label === memberRef)?.label : undefined;
            }).find(Boolean);
          const subject = /consumer price index/i.test(primary.cube.title) && category
            ? `${category} CPI` : category ?? concept?.label ?? topic;
          const places = [...new Set(requested.map((member) => member.label.split(",")[0]!.trim()))].join(", ");
          const substitutes = [...new Set(parents.map((member) => member.label.split(",")[0]!.trim()))].join(", ");
          substitutedReason = `Statistics Canada does not publish ${subject} for ${places}; showing ${substitutes}.`;
          step(steps, "substituted_geography", substitutedReason, "rule");
          const recorded = steps.find((entry) => entry.question === `d${geography.id}.members`);
          if (recorded) { recorded.answer = JSON.stringify(replacement.layers[0]!.dims[String(geography.id)]); recorded.source = "rule"; recorded.confidence = null; }
        }
      }
    }
    if (!usable(check)) {
      if (layers.length === 1 && !cues.groups) for (const candidate of list) {
        if (candidate === primary || !supports(candidate.cube, q, cues) ||
          concept && !concept.pids.includes(candidate.cube.pid) && !covers(candidate.cube, concept.label) ||
          !covers(candidate.cube, q)) continue;
        let selection;
        try { selection = await dimensions(candidate.cube, q, cues, signal, planner === "jev"); }
        catch (error) {
          if (signal?.aborted) throw error;
          selection = await dimensions(candidate.cube, q, cues, signal, false);
        }
        const candidateDims = selection.dims;
        const xDims = candidate.cube.dimensions.filter((d) => candidateDims[String(d.id)]?.use === "x");
        for (const d of xDims.slice(1)) candidateDims[String(d.id)]!.use = "series";
        const replacementChart = xDims.length && !["bar", "stacked_bar", "stacked_bar_100"].includes(chart) ? "bar" : chart;
        const replacementTransform = replacementChart === "bar" && xDims.length && cues.transform === "pct_change_yoy" &&
          !cues.latest && cues.range ? "pct_change_window"
          : !xDims.length && transform === "share_of_x" ? "level" : transform;
        let replacement: ViewSpec;
        let retry: ViewOutcome;
        try {
          replacement = ViewSpec.parse({ v: SPEC_VERSION, layers: [{ pid: candidate.cube.pid, dims: candidateDims }],
            time: candidate.cube.kind === "snapshot" ? { preset: "latest" } : time,
            chart: { type: replacementChart, ...(cues.horizontal !== undefined ? { horizontal: cues.horizontal } : {}) },
            transform: replacementTransform, ...(replacementTransform === "index_first" && cues.indexBase ? { index_base: cues.indexBase } : {}) });
          retry = await runView(db, replacement);
        } catch (error) {
          if (signal?.aborted) throw error;
          continue;
        }
        if (!usable(retry)) continue;
        spec = replacement;
        check = retry;
        primary = candidate;
        chart = replacementChart;
        transform = replacementTransform;
        if (candidate.cube.kind === "snapshot") {
          const recorded = steps.find((s) => s.question === "time");
          if (recorded) recorded.answer = JSON.stringify(spec.time);
        }
        for (const [question, answer] of [["chart", chart], ["transform", transform]]) {
          const recorded = steps.find((s) => s.question === question);
          if (recorded) { recorded.answer = answer; recorded.source = "rule"; recorded.confidence = null; }
        }
        const selectionStart = steps.findIndex((s) => /^d\d+\.members$/.test(s.question));
        if (selectionStart >= 0) steps.splice(selectionStart, selections[0]!.steps.length, ...selection.steps);
        const tableStep = steps.find((s) => s.question === "table");
        if (tableStep) { tableStep.answer = candidate.cube.pid; tableStep.source = "rule"; tableStep.confidence = null; }
        step(steps, "validation", "Retried a table with published data", "rule");
        break;
      }
      if (!usable(check)) {
        step(steps, "validation", check.kind === "invalid" ? check.error : "No published observations for this selection", "rule");
        return result("no_match", planner);
      }
    }
    if (check.kind === "ok" && cues.groups && cues.groups.length >= 2 && cues.groups.length <= 3 &&
      !cues.groups.some((group) => check.result.title.includes(group.label))) {
      const subject = check.result.title.replace(/^Population estimates\b/, "Population");
      const groupedTitle = `${subject}: ${cues.groups.map((group) => group.label).join(" vs ")}`;
      if (groupedTitle.length <= 200) spec.title = groupedTitle;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // An unavailable view engine must not turn an otherwise valid plan into a 500.
  }
  // A suggestion must open a chart with data: check each headline view, in parallel, before offering it.
  // When Jev ranked the tables, trust its probabilities. Title words alone offer near misses: "gas price"
  // expands to "consumer price index", which titles every CPI table.
  const probabilities = answers.table?.probabilities;
  const offered = list.filter(({ cube }, i) =>
    cube.pid !== primary.cube.pid && (
      probabilities ? (probabilities[`t${i}`] ?? 0) >= 0.02 : titleScore(cube.title, q) >= 2
    )).slice(0, 5).map(({ cube }) => ({ label: cube.title, spec: headline(cube, time) }));
  const alternatives: PlanResult["alternatives"] = (await Promise.all(offered.map(async (alternative) => {
    try {
      return usable(await runView(db, alternative.spec)) ? alternative : undefined;
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }))).filter((alternative) => alternative !== undefined).slice(0, 3);
  return result("ok", planner, spec, alternatives, substitutedReason);
}

/** Concurrent callers share work; one disconnect cancels only its own wait. The last disconnect aborts Jev. */
export async function planQuery(db: Db, input: string, opts: { view?: boolean; signal?: AbortSignal; origin?: string } = {}): Promise<PlanResult> {
  const q = input.trim().replace(/\s+/g, " ");
  const key = `${db.manifest.build_id}:${db.normalized.build_id}:${q}`;
  let entry = cache.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { promise: produce(db, q, controller.signal), controller, waiters: 0, pending: true };
    const current = entry;
    cache.set(key, entry);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    entry.promise.then(() => { current.pending = false; }, () => {
      current.pending = false;
      if (cache.get(key) === current) cache.delete(key);
    });
  } else { cache.delete(key); cache.set(key, entry); }
  entry.waiters++;
  const current = entry;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = opts.signal && new Promise<never>((_, reject) => {
      onAbort = () => reject(opts.signal!.reason ?? new Error("request aborted"));
      opts.signal!.addEventListener("abort", onAbort, { once: true });
      if (opts.signal!.aborted) onAbort();
    });
    const plan = await (aborted ? Promise.race([entry.promise, aborted]) : entry.promise);
    return opts.view ? attachView(db, plan, opts.origin) : plan;
  } finally {
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    current.waiters--;
    if (current.pending && current.waiters === 0) {
      current.controller.abort();
      if (cache.get(key) === current) cache.delete(key);
    }
  }
}
