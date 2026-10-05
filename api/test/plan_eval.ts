import { openFromEnv } from "../src/config.ts";
import { planQuery } from "../src/planner.ts";
import type { ChartType, PlanStatus, Transform } from "../src/spec.ts";

type Case = {
  q: string; status: PlanStatus; pid?: string; members?: string[]; layers?: string[];
  chart?: ChartType; horizontal?: boolean; transform?: Transform; use?: "series" | "x" | "sum";
  time?: string; openEnded?: boolean; xKind?: "time" | "category"; xDimension?: string; fixedPlace?: string;
  warnings?: string[]; warningCodes?: string[]; warningText?: string; reason?: string; missingPlaces?: string[];
  minSeries?: number; maxSeries?: number; minPeriods?: number; maxPeriods?: number; minCategories?: number;
  orderedCategories?: string[]; leadingCategories?: string[]; titleContains?: string; geoMemberCount?: number; totalDimensions?: number[];
  maxLayers?: number; groups?: string[]; groupSeries?: Record<string, number>;
  groupMethods?: Record<string, string>; methodStep?: string; noMatchReason?: string;
  measure?: string; unit?: string; axes?: number;
  planReason?: string | null; unpublishedPlaces?: string[]; publishedPlaces?: string[]; gapNote?: string; product?: string;
  unpublishedCoordinates?: { dimension: string; label: string }[];
  publishedCoordinates?: { dimension: string; label: string }[];
  indexBase?: string | null; basePoint?: string; firstIndex100?: boolean; outsideBase?: boolean;
  excludedMembers?: string[]; absentWarningCodes?: string[];
};

// Expected table identities come from the full Clean catalogue; tuned cases may change before holdout evaluation.
const tuned: Case[] = [
  { q: "c", status: "need_more" },
  { q: "un", status: "need_more" },
  { q: "the", status: "need_more" },
  { q: "how", status: "need_more" },
  { q: "best pasta recipe", status: "no_match" },
  { q: "who won the super bowl", status: "no_match" },
  { q: "fix my python code", status: "no_match" },
  { q: "cpi", status: "ok", pid: "18100004", chart: "line", transform: "level", time: "5Y", minPeriods: 60 },
  { q: "inflation", status: "ok", pid: "18100004", transform: "pct_change_yoy" },
  { q: "consumer price index", status: "ok", pid: "18100004", transform: "level" },
  { q: "cpi ontario", status: "ok", pid: "18100004", members: ["Ontario"] },
  { q: "cpi gasoline", status: "ok", pid: "18100004", members: ["Gasoline"], warnings: [] },
  { q: "cpi food in quebec", status: "ok", pid: "18100004", members: ["Food", "Quebec"] },
  { q: "gas vs. food cost by province, past year", status: "ok", pid: "18100004", members: ["Gasoline", "Food"], chart: "bar", transform: "level", time: "1Y", xKind: "category", use: "x", minSeries: 2, reason: "26 series" },
  { q: "food vs shelter inflation past 5 years", status: "ok", pid: "18100004", members: ["Food", "Shelter"], chart: "line", use: "series", transform: "pct_change_yoy" },
  { q: "rent inflation toronto", status: "ok", pid: "18100004", members: ["Rented accommodation", "Toronto, Ontario"], transform: "pct_change_yoy" },
  { q: "population", status: "ok", pid: "17100009", transform: "level" },
  { q: "population by province", status: "ok", pid: "17100009", chart: "line", transform: "level", time: "5Y", xKind: "time", use: "series", minSeries: 10, minPeriods: 2 },
  { q: "population of the territories since 2000", status: "ok", pid: "17100009", chart: "line", use: "series", time: "2000" },
  { q: "population ontario and quebec since 2015", status: "ok", pid: "17100009", members: ["Ontario", "Quebec"], chart: "line", use: "series", time: "2015" },
  { q: "population provinces vs territories since 2015", status: "ok", pid: "17100009", groups: ["Provinces", "Territories"], chart: "line", use: "series", time: "2015" },
  { q: "sum of provincial population since 2015", status: "ok", pid: "17100009", use: "sum", chart: "line", time: "2015" },
  { q: "unemployment rate", status: "ok", pid: "14100287", members: ["Unemployment rate"] },
  { q: "unemployment rate ontario vs quebec since 2015", status: "ok", pid: "14100287", members: ["Ontario", "Quebec", "Unemployment rate"], chart: "line", use: "series", time: "2015" },
  { q: "employment vs unemployment in alberta", status: "ok", pid: "14100287", members: ["Alberta", "Employment", "Unemployment"] },
  { q: "labour force participation rate past 5 years", status: "ok", pid: "14100287", chart: "line", time: "5Y" },
  { q: "monthly retail sales by province", status: "ok", pid: "20100056", chart: "line", use: "series", time: "5Y" },
  { q: "retail trade since 2018", status: "ok", pid: "20100056", chart: "line", time: "2018" },
  { q: "GDP by industry", status: "ok", pid: "36100434", chart: "bar", use: "x", minCategories: 15 },
  { q: "monthly GDP since 2015", status: "ok", pid: "36100434", chart: "line", time: "2015" },
  { q: "housing starts", status: "ok", pid: "34100158" },
  { q: "housing starts by province latest", status: "ok", pid: "34100158", chart: "bar", use: "x" },
  { q: "average weekly earnings by province", status: "ok", pid: "14100223", chart: "line", use: "series", time: "5Y" },
  { q: "average weekly earnings by industry", status: "ok", pid: "14100220", chart: "bar", use: "x", minCategories: 12 },
  { q: "employment by industry", status: "ok", pid: "14100201", chart: "bar", use: "x", minCategories: 12 },
  { q: "exports to the us", status: "ok", pid: "12100182", members: ["United States"], chart: "line", xKind: "time", warnings: [] },
  { q: "international merchandise trade monthly", status: "ok", pid: "12100163" },
  { q: "food vs gasoline prices in Canada", status: "ok", pid: "18100004", members: ["Food", "Gasoline"] },
  { q: "cpi gasoline prices past year", status: "ok", pid: "18100004", members: ["Gasoline"], chart: "line", time: "1Y" },
  { q: "cpi ontario since 2018", status: "ok", pid: "18100004", members: ["Ontario"], chart: "line", time: "2018" },
  { q: "18-10-0004-01", status: "ok", pid: "18100004" },
  { q: "17-10-0009-01", status: "ok", pid: "17100009" },
  { q: "population in 2021", status: "ok", pid: "17100009", time: "2021" },
  { q: "population vs inflation since 2015", status: "ok", layers: ["17100009", "18100004"], chart: "line", transform: "pct_change_yoy", time: "2015" },
  { q: "unemployment vs inflation since 2015", status: "ok", layers: ["14100287", "18100004"], chart: "line", transform: "pct_change_yoy", time: "2015" },
  { q: "unemployment vs cpi since 2015", status: "ok", layers: ["14100287", "18100004"],
    chart: "line", transform: "level", time: "2015", axes: 2 },
  { q: "population vs inflation since 2015 indexed to 100", status: "ok", layers: ["17100009", "18100004"],
    chart: "line", transform: "index_first", time: "2015", unit: "index (first = 100)", axes: 1 },
  { q: "hourly wage vs cpi", status: "ok", layers: ["14100065", "18100004"],
    members: ["Average hourly wage rate", "All-items"], chart: "line", transform: "index_first",
    unit: "index (first = 100)", axes: 1, firstIndex100: true, time: "5Y", minPeriods: 60,
    absentWarningCodes: ["no_data", "mixed_frequency"] },
  { q: "wages vs inflation", status: "ok", layers: ["14100065", "18100004"],
    members: ["Average hourly wage rate", "All-items"], chart: "line", transform: "pct_change_yoy",
    unit: "%", axes: 1, absentWarningCodes: ["no_data", "mixed_frequency"] },
  { q: "average weekly earnings vs cpi", status: "ok", layers: ["14100223", "18100004"],
    members: ["Average weekly earnings including overtime for all employees",
      "Industrial aggregate excluding unclassified businesses", "All-items"],
    chart: "line", transform: "index_first", unit: "index (first = 100)", axes: 1,
    firstIndex100: true, absentWarningCodes: ["no_data", "mixed_frequency"] },
  { q: "unemployment rate vs cpi", status: "ok", layers: ["14100287", "18100004"],
    members: ["Unemployment rate", "All-items"], chart: "line", transform: "level", axes: 2,
    absentWarningCodes: ["no_data", "mixed_frequency"] },
  { q: "how much did groceries go up compared to gas in each province this year", status: "ok", pid: "18100004", members: ["Food", "Gasoline"], chart: "bar", transform: "pct_change_window", time: "1Y", minCategories: 10 },
  { q: "price of gasoline vs food in each province over the last year", status: "ok", pid: "18100004", members: ["Gasoline", "Food"], chart: "bar", transform: "level", time: "1Y", minCategories: 10 },
  { q: "jobless rate in BC since 2020", status: "ok", pid: "14100287", members: ["British Columbia", "Unemployment rate"], chart: "line", time: "2020" },
  { q: "home building in each province", status: "ok", pid: "34100158", chart: "line", use: "series", time: "5Y", minSeries: 10 },
  { q: "rent", status: "ok", pid: "18100004", members: ["Rented accommodation"] },
  { q: "cost of living in Nova Scotia past 12 months", status: "ok", pid: "18100004", members: ["Nova Scotia"], time: "1Y" },
  { q: "manufacturing sales in Alberta", status: "ok", pid: "16100048", members: ["Alberta"] },
  { q: "people living in Prince Edward Island since 2010", status: "ok", pid: "17100009", members: ["Prince Edward Island"], time: "2010" },
  { q: "crude oil output in Alberta over time", status: "ok", pid: "25100063", members: ["Alberta"], chart: "line" },
  { q: "apartment vacancy in Toronto", status: "ok", pid: "34100127", members: ["Toronto"] },
  { q: "number of cattle on farms", status: "ok", pid: "32100130", members: ["Total cattle"] },
  { q: "new vehicle registrations in Quebec", status: "ok", pid: "20100025", members: ["Quebec"] },
  { q: "quarterly visitor spending in Canada", status: "ok", pid: "36100230" },
  { q: "crime severity index by province", status: "ok", pid: "35100026" },
  { q: "federal government debt", status: "ok", pid: "10100002" },
  { q: "unemployment among women versus men this year", status: "ok", pid: "14100287", members: ["Women+", "Men+"], measure: "Unemployment rate" },
  { q: "employment rate for young adults compared with older workers last year", status: "ok", pid: "14100287", members: ["15 to 24 years", "55 years and over"], measure: "Employment rate" },
  { q: "unemployment in Ontario since 2020", status: "ok", pid: "14100287", members: ["Ontario"], measure: "Unemployment rate" },
  { q: "how much did population grow in Alberta over the past five years?", status: "ok", pid: "17100009", members: ["Alberta"], transform: "pct_change_yoy" },
  { q: "GDP growth in Canada last year", status: "ok", pid: "36100434", members: ["All industries"], chart: "line", transform: "pct_change_yoy", time: "1Y" },
  { q: "housing starts in Canada in 1989", status: "ok", pid: "34100148", time: "1989" },
  { q: "food service sales in Ontario this year", status: "ok", pid: "21100019", members: ["Receipts", "Ontario"] },
  { q: "food and beverage retailer sales by province", status: "ok", pid: "20100056", members: ["Food and beverage retailers"], chart: "line", use: "series", time: "5Y" },
  { q: "gasoline sales in litres across provinces", status: "ok", pid: "23100066", members: ["Net sales of gasoline"], chart: "line", use: "series", time: "5Y", minSeries: 10 },
  { q: "monthly gasoline sales in litres in Ontario during 2005", status: "ok", pid: "23100080", members: ["Ontario", "Net sales of gasoline"], time: "2005" },
  { q: "deaths by cause in Ontario", status: "ok", pid: "13100932", members: ["Ontario"],
    chart: "bar", use: "x", xKind: "category", time: "latest", minCategories: 20, maxPeriods: 1 },
  { q: "monthly GDP by seasonal adjustment", status: "ok", pid: "36100434",
    chart: "line", use: "series", xKind: "time", minSeries: 2,
    unpublishedCoordinates: [{ dimension: "Seasonal adjustment", label: "Trading-day adjusted" }],
    publishedCoordinates: [{ dimension: "Seasonal adjustment", label: "Seasonally adjusted at annual rates" }],
    warningCodes: ["no_data"], gapNote: "Trading-day adjusted" },
  { q: "unemployment rate by age group", status: "ok", pid: "14100287",
    chart: "line", use: "series", xKind: "time", minSeries: 6 },
  { q: "average retail prices for milk in Ontario in dollars", status: "ok", pid: "18100245", members: ["Milk, 1 litre", "Ontario"] },
  { q: "resale home sales in Canada last year", status: "no_match" },
];

// Previously published holdout cases plus new untouched paraphrases.
const heldout: Case[] = [
  { q: "gasoline prices in Quebec past 2 years", status: "ok", pid: "18100004", members: ["Quebec", "Gasoline"], chart: "line", time: "2Y" },
  { q: "food inflation in British Columbia since 2020", status: "ok", pid: "18100004", members: ["British Columbia", "Food"], chart: "line", transform: "pct_change_yoy", time: "2020" },
  { q: "housing starts Ontario over time", status: "ok", pid: "34100158", members: ["Ontario"], chart: "line" },
  { q: "GDP by industry since 2015", status: "ok", pid: "36100434", chart: "bar", use: "x", minCategories: 15, time: "2015" },
  { q: "average weekly earnings by province latest", status: "ok", pid: "14100223", chart: "bar", use: "x" },
  { q: "employment by industry past 5 years", status: "ok", pid: "14100201", chart: "bar", use: "x", minCategories: 12, time: "5Y" },
  { q: "exports to United States by commodity", status: "ok", members: ["United States"], chart: "line", use: "series", time: "5Y", minSeries: 12 },
  { q: "population Alberta and Saskatchewan since 2010", status: "ok", pid: "17100009", members: ["Alberta", "Saskatchewan"], chart: "line", use: "series", time: "2010" },
  { q: "unemployment rate Canada this year", status: "ok", pid: "14100287", members: ["Unemployment rate"] },
  { q: "retail sales by province 2021-2025", status: "ok", pid: "20100056", chart: "line", use: "series", time: "2021" },
  { q: "rent inflation Toronto over time", status: "ok", pid: "18100004", members: ["Rented accommodation", "Toronto, Ontario"], chart: "line", transform: "pct_change_yoy" },
  { q: "consumer price index by province current", status: "ok", pid: "18100004", chart: "bar", use: "x" },
  { q: "population provinces vs territories since 2020", status: "ok", pid: "17100009", groups: ["Provinces", "Territories"], chart: "line", use: "series", time: "2020" },
  { q: "who wrote Hamlet", status: "no_match" },
  { q: "s", status: "need_more" },
  { q: "food and motor fuel consumer prices around the provinces since 2021", status: "ok", pid: "18100004", members: ["Food", "Gasoline"], time: "2021" },
  { q: "British Columbia joblessness starting in 2020", status: "ok", pid: "14100287", members: ["British Columbia"], chart: "line", time: "2020", openEnded: true },
  { q: "new homes being built across the provinces", status: "ok", pid: "34100158", chart: "line", use: "series", time: "5Y", minSeries: 10 },
  { q: "average apartment rents in Toronto", status: "ok", pid: "34100133", members: ["Toronto"] },
  { q: "weekly pay in Saskatchewan", status: "ok", pid: "14100223", members: ["Saskatchewan"] },
  { q: "electricity generated by wind", status: "ok", pid: "25100015", members: ["Wind power turbine"] },
  { q: "tuition fees in Quebec", status: "ok", pid: "37100120", members: ["Quebec"] },
  { q: "amount of wheat harvested", status: "ok", pid: "32100359", members: ["Wheat, all"] },
  { q: "violent incidents reported to police", status: "ok", pid: "35100177" },
  { q: "gross domestic product in Ontario by industry", status: "ok", pid: "36100711", members: ["Ontario"] },
  { q: "rail cargo tonnage", status: "ok", pid: "23100216" },
  { q: "government budgets of the provinces", status: "ok", pid: "10100017" },
];
// New paraphrases stay separate from tuned cases; report their first-pass result independently.
const fresh: Case[] = [
  { q: "employment rate for men versus women in Ontario", status: "ok", pid: "14100287", measure: "Employment rate", members: ["Men+", "Women+"] },
  { q: "joblessness among youth and adults in Quebec", status: "ok", pid: "14100287", measure: "Unemployment rate", members: ["Quebec", "15 to 24 years", "25 years and over"] },
  { q: "population growth in Quebec over the past decade", status: "ok", pid: "17100009", transform: "pct_change_yoy", members: ["Quebec"] },
  { q: "how has Canadian GDP grown since 2018", status: "ok", pid: "36100434", transform: "pct_change_yoy", members: ["All industries"] },
  { q: "restaurant sales in British Columbia this year", status: "ok", pid: "21100019", members: ["British Columbia", "Receipts"] },
  { q: "road gasoline volume by province in litres", status: "ok", pid: "23100066", members: ["Net sales of gasoline"], chart: "line", use: "series", time: "5Y", minSeries: 10 },
  { q: "annual deaths by cause in Alberta", status: "ok", pid: "13100932", members: ["Alberta"] },
  { q: "average retail price of butter in Quebec in dollars", status: "ok", pid: "18100245", members: ["Quebec", "Butter, 454 grams"] },
  { q: "existing home sales in Toronto last year", status: "no_match" },
  { q: "Canadian house resale transactions", status: "no_match" },
];

// Census paraphrases require a published category breakdown at one fixed place.
const census: Case[] = [
  { q: "2021 Census population and dwelling counts for Toronto census subdivision", status: "ok", pid: "98100015",
    chart: "bar", xKind: "category", xDimension: "Population and dwelling counts", fixedPlace: "Toronto", minCategories: 3 },
  { q: "What does the 2021 Census age structure look like in Ontario?", status: "ok", pid: "98100034",
    chart: "bar", xKind: "category", xDimension: "Broad age groups", fixedPlace: "Ontario", minCategories: 3 },
  { q: "In the 2021 Census how many Albertans know English and French?", status: "ok", pid: "98100222",
    chart: "bar", xKind: "category", xDimension: "Knowledge of official languages", fixedPlace: "Alberta", minCategories: 4 },
  { q: "2021 Census knowledge of official languages in Halifax", status: "ok", pid: "98100223",
    chart: "bar", xKind: "category", xDimension: "Knowledge of official languages", fixedPlace: "Halifax", minCategories: 4 },
  { q: "Languages most often spoken at home in Quebec according to the 2021 Census", status: "ok", pid: "98100226",
    chart: "bar", xKind: "category", fixedPlace: "Quebec", minCategories: 4 },
  { q: "Mother tongues reported by Ontario residents in the 2021 Census", status: "ok", pid: "98100218",
    chart: "bar", xKind: "category", xDimension: "Mother tongue", fixedPlace: "Ontario", minCategories: 4 },
  { q: "2021 Census immigrant versus non-immigrant population in Toronto by arrival period", status: "ok", pid: "98100347",
    chart: "bar", xKind: "category", xDimension: "Immigrant status and period of immigration", fixedPlace: "Toronto",
    members: ["Non-immigrants", "Before 2001"], minCategories: 5, maxLayers: 1 },
  { q: "Canadian citizenship by immigrant status from the 2021 Census", status: "ok", pid: "98100303",
    chart: "bar", xKind: "category", xDimension: "Immigrant status and period of immigration", fixedPlace: "Canada", minCategories: 3 },
  { q: "2021 Census Indigenous identity by age in Manitoba", status: "ok", pid: "98100292",
    chart: "bar", xKind: "category", xDimension: "Age", fixedPlace: "Manitoba", minCategories: 5 },
  { q: "2021 Census homeowners versus renters in Vancouver", status: "ok", pid: "98100239",
    chart: "bar", xKind: "category", xDimension: "Tenure", fixedPlace: "Vancouver", minCategories: 2 },
  { q: "How did Toronto residents commute to work in the 2021 Census?", status: "ok", pid: "98100457",
    chart: "bar", xKind: "category", xDimension: "Main mode of commuting", fixedPlace: "Toronto", minCategories: 4 },
  { q: "Highest education completed in Ontario in the 2021 Census", status: "ok", pid: "98100386",
    chart: "bar", xKind: "category", xDimension: "Highest certificate", fixedPlace: "Ontario", minCategories: 3 },
  { q: "What was Quebec's 2021 Census after-tax income distribution?", status: "ok", pid: "98100065",
    chart: "bar", xKind: "category", xDimension: "After-tax income groups", fixedPlace: "Quebec", minCategories: 10 },
  { q: "How were families structured in Canada in the 2021 Census?", status: "ok", pid: "98100123",
    chart: "bar", xKind: "category", xDimension: "Census family structure", fixedPlace: "Canada", minCategories: 2 },
  { q: "98100034", status: "ok", pid: "98100034",
    chart: "bar", xKind: "category", xDimension: "Broad age groups", fixedPlace: "Canada", minCategories: 3 },
  { q: "Census age structure in Ontario since 2015", status: "ok", pid: "17100005", chart: "line", time: "2015" },
];

// Untuned paraphrases cover named geography, geographic x axes, natural commuting, and current vehicle sales.
const patterns: Case[] = [
  { q: "Broad age groups in Swift Current from the 2021 census", status: "ok", pid: "98100030",
    chart: "bar", xDimension: "Broad age groups", fixedPlace: "Swift Current", warnings: [], minCategories: 3 },
  { q: "2021 Census commute choices in Moose Jaw", status: "ok", pid: "98100457",
    xDimension: "Main mode of commuting", fixedPlace: "Moose Jaw", warnings: [], minCategories: 4 },
  { q: "Official language knowledge in Fooville from the 2021 Census", status: "ok", pid: "98100222",
    fixedPlace: "Canada", warnings: ["member_not_found"] },
  { q: "2021 Census renters by province", status: "ok", pid: "98100239",
    chart: "bar", xDimension: "Geography", members: ["Owner", "Renter"], minCategories: 10, minSeries: 2, warnings: [] },
  { q: "Indigenous identity across provinces, 2021 Census", status: "ok", pid: "98100292",
    chart: "bar", xDimension: "Geography", minCategories: 10, minSeries: 2, warnings: [] },
  { q: "2021 Census home ownership by city", status: "ok", pid: "98100239",
    chart: "bar", xDimension: "Geography", minCategories: 100, minSeries: 2, warnings: [] },
  { q: "How do Canadians travel to their jobs?", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Main mode of commuting", minCategories: 4, warnings: [] },
  { q: "How did people get to work in Manitoba in 2021?", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Main mode of commuting", fixedPlace: "Manitoba", minCategories: 4, warnings: [] },
  { q: "Canadian automobile sales", status: "ok", pid: "20100085",
    members: ["Passenger cars"], chart: "line", xKind: "time", warnings: [] },
  { q: "new car sales in Ontario", status: "ok", pid: "20100085",
    members: ["Passenger cars", "Ontario"], xKind: "time", warnings: [] },
  { q: "annual car sales in Canada", status: "ok", pid: "20100086",
    members: ["Passenger cars", "Canada"], xKind: "time", warnings: [] },
];

// New wording held separate from the retained suites: place tokens are geography, not topics.
const regressions: Case[] = [
  // The same Census categories must survive city extraction in all three query orders.
  { q: "age breakdown of saskatoon", status: "ok", pid: "98100030", chart: "bar",
    xDimension: "Broad age groups", fixedPlace: "Saskatoon (CMA), Sask.", minCategories: 3, warnings: [] },
  { q: "age groups in Kelowna", status: "ok", pid: "98100030",
    xDimension: "Broad age groups", fixedPlace: "Kelowna (CMA), B.C.", minCategories: 3, warnings: [] },
  { q: "Halifax age profile", status: "ok", pid: "98100030",
    xDimension: "Broad age groups", fixedPlace: "Halifax (CMA), N.S.", minCategories: 3, warnings: [] },
  { q: "age distribution of Regina", status: "ok", pid: "98100030",
    xDimension: "Broad age groups", fixedPlace: "Regina (CMA), Sask.", minCategories: 3, warnings: [] },
  { q: "home language breakdown of Regina", status: "ok", pid: "98100227",
    xDimension: "Language", fixedPlace: "Regina (CMA), Sask.", minCategories: 4, warnings: [] },
  { q: "knowledge of official languages in Halifax", status: "ok", pid: "98100223",
    xDimension: "Knowledge of official languages", fixedPlace: "Halifax (CMA), N.S.", minCategories: 4, warnings: [] },
  { q: "Kelowna home languages", status: "ok", pid: "98100227",
    xDimension: "Language", fixedPlace: "Kelowna (CMA), B.C.", minCategories: 4, warnings: [] },
  { q: "commuting breakdown of Kelowna", status: "ok", pid: "98100457",
    xDimension: "Main mode of commuting", fixedPlace: "Kelowna (CMA), B.C.", minCategories: 4, warnings: [] },
  { q: "commute choices in Halifax", status: "ok", pid: "98100457",
    xDimension: "Main mode of commuting", fixedPlace: "Halifax (CMA), N.S.", minCategories: 4, warnings: [] },
  { q: "Regina commuting options", status: "ok", pid: "98100457",
    xDimension: "Main mode of commuting", fixedPlace: "Regina (CMA), Sask.", minCategories: 4, warnings: [] },
  { q: "tenure breakdown of Saskatoon", status: "ok", pid: "98100239",
    xDimension: "Tenure", fixedPlace: "Saskatoon (CMA), Sask.", minCategories: 3, warnings: [] },
  { q: "home ownership in Kelowna", status: "ok", pid: "98100239",
    xDimension: "Tenure", fixedPlace: "Kelowna (CMA), B.C.", minCategories: 3, warnings: [] },
  { q: "Halifax housing tenure", status: "ok", pid: "98100239",
    xDimension: "Tenure", fixedPlace: "Halifax (CMA), N.S.", minCategories: 3, warnings: [] },
  // Sales count, rather than sale prices or buyer/owner counts, remains WDS.
  { q: "housing sales by province", status: "ok", pid: "46100057", chart: "bar",
    xDimension: "Geography", orderedCategories: ["Nova Scotia", "New Brunswick", "British Columbia"],
    members: ["Number of properties sold"], warnings: [] },
  { q: "residential property transactions across provinces", status: "ok", pid: "46100057",
    xDimension: "Geography", members: ["Number of properties sold"], minCategories: 3, warnings: [] },
  { q: "home sales in Halifax", status: "ok", pid: "46100057",
    fixedPlace: "Halifax, Census metropolitan area (CMA)", members: ["Number of properties sold"], warnings: [] },
  { q: "Halifax home sales", status: "ok", pid: "46100057",
    fixedPlace: "Halifax, Census metropolitan area (CMA)", members: ["Number of properties sold"], warnings: [] },
  { q: "Saskatoon consumer prices", status: "ok", pid: "18100004",
    fixedPlace: "Saskatoon, Saskatchewan", members: ["All-items"], xKind: "time", warnings: [] },
  { q: "Calgary housing tenure", status: "ok", pid: "98100239",
    fixedPlace: "Calgary (CMA), Alta.", xDimension: "Tenure", minCategories: 3, warnings: [] },
  // A city can publish All-items but not the requested CPI component. Preserve its empty series.
  { q: "food prices in Calgary", status: "ok", pid: "18100004", members: ["Food", "Calgary", "Alberta"], product: "Food",
    unpublishedPlaces: ["Calgary"], publishedPlaces: ["Alberta"], warningCodes: ["no_data", "substituted_geography"],
    planReason: "Statistics Canada does not publish Food CPI for Calgary; showing Alberta.", gapNote: "Calgary", maxLayers: 1 },
  { q: "grocery prices in Halifax", status: "ok", pid: "18100004", members: ["Food", "Halifax", "Nova Scotia"], product: "Food",
    unpublishedPlaces: ["Halifax"], publishedPlaces: ["Nova Scotia"], warningCodes: ["no_data", "substituted_geography"],
    planReason: "Statistics Canada does not publish Food CPI for Halifax; showing Nova Scotia.", gapNote: "Halifax", maxLayers: 1 },
  { q: "Saskatoon food inflation", status: "ok", pid: "18100004", members: ["Food", "Saskatoon", "Saskatchewan"], product: "Food",
    unpublishedPlaces: ["Saskatoon"], publishedPlaces: ["Saskatchewan"], warningCodes: ["no_data", "substituted_geography"],
    planReason: "Statistics Canada does not publish Food CPI for Saskatoon; showing Saskatchewan.", gapNote: "Saskatoon", maxLayers: 1 },
  { q: "food prices in Calgary vs Alberta", status: "ok", pid: "18100004", members: ["Food", "Calgary", "Alberta"], product: "Food",
    unpublishedPlaces: ["Calgary"], publishedPlaces: ["Alberta"], warningCodes: ["no_data"],
    planReason: null, gapNote: "Calgary", maxLayers: 1 },
  { q: "food prices Calgary vs Edmonton vs Toronto", status: "ok", pid: "18100004", product: "Food",
    members: ["Food", "Calgary", "Edmonton", "Toronto", "Alberta", "Ontario"],
    unpublishedPlaces: ["Calgary", "Edmonton", "Toronto"], publishedPlaces: ["Alberta", "Ontario"],
    warningCodes: ["no_data", "substituted_geography"], gapNote: "Calgary", maxLayers: 1,
    planReason: "Statistics Canada does not publish Food CPI for Calgary, Edmonton, Toronto; showing Alberta, Ontario." },
  { q: "CPI gasoline in Calgary", status: "ok", pid: "18100004", members: ["Gasoline", "Calgary", "Alberta"], product: "Gasoline",
    unpublishedPlaces: ["Calgary"], publishedPlaces: ["Alberta"], warningCodes: ["no_data", "substituted_geography"],
    planReason: "Statistics Canada does not publish Gasoline CPI for Calgary; showing Alberta.", maxLayers: 1 },
  { q: "French speakers in New Brunswick", status: "ok", pid: "98100222",
    chart: "bar", fixedPlace: "New Brunswick", minCategories: 4, warnings: [] },
  { q: "Home languages of people living in Nova Scotia", status: "ok", pid: "98100226",
    chart: "bar", fixedPlace: "Nova Scotia", minCategories: 4, warnings: [] },
  { q: "French speakers in Prince Edward Island", status: "ok", pid: "98100222",
    fixedPlace: "Prince Edward Island", warnings: [] },
  { q: "English speakers in Saint John", status: "ok", pid: "98100223",
    fixedPlace: "Saint John", warnings: [] },
  { q: "New housing price index in New Brunswick", status: "ok", pid: "18100205",
    xKind: "time", warnings: [] },
  { q: "price index", status: "ok", pid: "18100004",
    xKind: "time", fixedPlace: "Canada", warnings: [] },
  { q: "Bicycle commute in Regina compared with Saskatoon", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Geography", orderedCategories: ["Regina", "Saskatoon"], members: ["Bicycle"], warnings: [] },
  { q: "Bicycle commuting in Moncton versus Halifax", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Geography", orderedCategories: ["Moncton", "Halifax"], members: ["Bicycle"], warnings: [] },
  { q: "Bicycle commute in Saskatoon vs Winnipeg vs Regina", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Geography", orderedCategories: ["Saskatoon", "Winnipeg", "Regina"], members: ["Bicycle"], warnings: [] },
  { q: "Public transit commuting in Saskatoon vs Regina", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Geography", orderedCategories: ["Saskatoon", "Regina"], members: ["Public transit"], warnings: [] },
  { q: "Cycling commute in Saskatoon compared with Regina", status: "ok", pid: "98100457",
    chart: "bar", xDimension: "Geography", orderedCategories: ["Saskatoon", "Regina"], members: ["Bicycle"], warnings: [] },
  { q: "Bicycle commuting in Kitchener versus Victoria", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Kitchener - Cambridge - Waterloo (CMA), Ont.", "Victoria (CMA), B.C."],
    members: ["Bicycle"], maxSeries: 1, geoMemberCount: 2, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "bike commuting in cambridge compared with mission", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Kitchener - Cambridge - Waterloo (CMA), Ont.", "Abbotsford - Mission (CMA), B.C."],
    members: ["Bicycle"], maxSeries: 1, geoMemberCount: 2, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "commute by bike in ottawa vs victoria", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Ottawa - Gatineau (CMA), Ont./Que.", "Victoria (CMA), B.C."],
    members: ["Bicycle"], maxSeries: 1, geoMemberCount: 2, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "Bicycle commuting in Halifax versus Fooville", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Halifax (CMA), N.S."], members: ["Bicycle"], maxSeries: 1,
    geoMemberCount: 1, missingPlaces: ["Fooville"], totalDimensions: [2, 3, 4, 5, 7], warnings: ["member_not_found"] },
  { q: "Bicycle commuting in Fooville compared with Ottawa", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Ottawa - Gatineau (CMA), Ont./Que."], members: ["Bicycle"],
    maxSeries: 1, geoMemberCount: 1, missingPlaces: ["Fooville"], warnings: ["member_not_found"] },
  { q: "Bicycle commuting in Fooville versus Barville", status: "ok", pid: "98100457",
    fixedPlace: "Canada", members: ["Bicycle"], maxSeries: 1, totalDimensions: [2, 3, 4, 5, 7],
    missingPlaces: ["Fooville", "Barville"], warnings: ["member_not_found", "member_not_found"] },
  { q: "transit use in Vancouver versus Calgary", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Vancouver (CMA), B.C.", "Calgary (CMA), Alta."],
    members: ["Public transit"], maxSeries: 1, geoMemberCount: 2, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "transit use in montreal compared with toronto", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Montréal (CMA), Que.", "Toronto (CMA), Ont."],
    members: ["Public transit"], maxSeries: 1, geoMemberCount: 2, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "When did Toronto commuters leave for work in the 2021 Census?", status: "ok", pid: "98100457",
    xDimension: "Time leaving for work", fixedPlace: "Toronto", minCategories: 6, warnings: [] },
  { q: "walk commute in Halifax versus Regina", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Halifax", "Regina"], members: ["Walked"],
    maxSeries: 1, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "walking to work in Saskatoon vs Winnipeg vs Regina", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Saskatoon", "Winnipeg", "Regina"], members: ["Walked"],
    maxSeries: 1, geoMemberCount: 3, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "walked to work in Halifax vs Regina", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Halifax", "Regina"], members: ["Walked"],
    maxSeries: 1, totalDimensions: [2, 3, 4, 5, 7], warnings: [] },
  { q: "biking to work in Moncton vs Halifax", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Moncton", "Halifax"], members: ["Bicycle"], maxSeries: 1, warnings: [] },
  { q: "drive to work in Ottawa vs Victoria", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Ottawa - Gatineau (CMA), Ont./Que.", "Victoria (CMA), B.C."],
    members: ["Car, truck or van"], maxSeries: 1, warnings: [] },
  { q: "driving commute in Halifax vs Regina", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Halifax", "Regina"],
    members: ["Car, truck or van"], maxSeries: 1, warnings: [] },
  { q: "bus commute in Halifax vs Regina", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Halifax", "Regina"],
    members: ["Public transit"], maxSeries: 1, warnings: [] },
  { q: "subway commuting in Toronto vs Montréal", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Toronto", "Montréal"],
    members: ["Public transit"], maxSeries: 1, warnings: [] },
  { q: "train commute in Toronto vs Montréal", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Toronto", "Montréal"],
    members: ["Public transit"], maxSeries: 1, warnings: [] },
  { q: "motorcycle commuting in Halifax vs Regina", status: "ok", pid: "98100457",
    xDimension: "Geography", orderedCategories: ["Halifax", "Regina"],
    members: ["Motorcycle, scooter or moped"], maxSeries: 1, warnings: [] },
  { q: "rent in kitchener vs atlantis", status: "ok", pid: "46100092",
    fixedPlace: "Kitchener - Cambridge - Waterloo, Census metropolitan area (CMA)",
    members: ["Average asking rent"], maxLayers: 1, missingPlaces: ["atlantis"], warnings: ["member_not_found"] },
  { q: "rental costs in Kitchener versus Atlantis", status: "ok", pid: "46100092",
    fixedPlace: "Kitchener - Cambridge - Waterloo, Census metropolitan area (CMA)",
    members: ["Average asking rent"], maxLayers: 1, missingPlaces: ["Atlantis"], warnings: ["member_not_found"] },
  { q: "rent in Fooville compared with Cambridge", status: "ok", pid: "46100092",
    fixedPlace: "Kitchener - Cambridge - Waterloo, Census metropolitan area (CMA)",
    members: ["Average asking rent"], maxLayers: 1, missingPlaces: ["Fooville"], warnings: ["member_not_found"] },
  { q: "rent inflation in Toronto versus Atlantis", status: "ok", pid: "18100004",
    fixedPlace: "Toronto, Ontario", members: ["Rented accommodation"], maxLayers: 1,
    missingPlaces: ["Atlantis"], warnings: ["member_not_found"] },
  // Region aliases are geographic selections, not concepts or arithmetic on incompatible units.
  { q: "unemployment rate, provinces vs. territories", status: "ok", pid: "14100287",
    layers: ["14100287", "14100292"], groups: ["Provinces", "Territories"],
    groupSeries: { Provinces: 1, Territories: 1 }, groupMethods: { Territories: "ratio" },
    measure: "Unemployment rate", transform: "level", unit: "Percent", axes: 1,
    methodStep: "Territories: 3-month moving average (14-10-0292-01); Provinces: monthly (14-10-0287-01).",
    warningCodes: ["group_method_difference"], warningText: "Territories: 3-month moving average (14-10-0292-01); Provinces: monthly (14-10-0287-01)." },
  { q: "population provinces vs territories", status: "ok", pid: "17100009",
    groups: ["Provinces", "Territories"], groupSeries: { Provinces: 1, Territories: 1 },
    groupMethods: { Provinces: "sum", Territories: "sum" } },
  { q: "population prairies vs atlantic vs central", status: "ok", pid: "17100009",
    groups: ["Prairies", "Atlantic provinces", "Central Canada"],
    groupSeries: { Prairies: 1, "Atlantic provinces": 1, "Central Canada": 1 } },
  { q: "cpi prairies vs maritimes", status: "ok", pid: "18100004",
    groups: ["Prairies", "Maritimes"], groupSeries: { Prairies: 3, Maritimes: 3 },
    warningCodes: ["group_not_combined"] },
  { q: "median income by region", status: "ok",
    groups: ["Atlantic", "Quebec", "Ontario", "Prairies", "BC", "Territories"],
    groupSeries: { Atlantic: 1, Quebec: 1, Ontario: 1, Prairies: 1, BC: 1, Territories: 1 } },
  { q: "employment rate west vs east", status: "ok", pid: "14100287",
    groups: ["Western Canada", "Eastern Canada"],
    groupSeries: { "Western Canada": 1, "Eastern Canada": 1 },
    groupMethods: { "Western Canada": "ratio", "Eastern Canada": "ratio" } },
  { q: "gdp by region", status: "ok",
    groups: ["Atlantic", "Quebec", "Ontario", "Prairies", "BC", "Territories"],
    groupSeries: { Atlantic: 1, Quebec: 1, Ontario: 1, Prairies: 1, BC: 1, Territories: 1 } },
  { q: "canadian shield population", status: "no_match", noMatchReason: "province borders" },
  { q: "ontario vs the maritimes population", status: "ok", pid: "17100009",
    groups: ["Ontario", "Maritimes"], groupSeries: { Ontario: 1, Maritimes: 1 } },
  // Time-first defaults, explicit chart types, and windows independent of transforms.
  // Index bases identify published periods independently of the visible window.
  { q: "cpi indexed to 2015", status: "ok", pid: "18100004", chart: "line", transform: "index_first",
    indexBase: "2015", time: "5Y", outsideBase: true, unit: "index (2015 = 100)" },
  { q: "population vs inflation since 2018 indexed to 2015", status: "ok",
    layers: ["17100009", "18100004"], chart: "line", transform: "index_first",
    indexBase: "2015", time: "2018", outsideBase: true, unit: "index (2015 = 100)", axes: 1 },
  { q: "cpi index 2015 = 100 since 2015", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: "2015", time: "2015", basePoint: "2015-01", unit: "index (2015 = 100)" },
  { q: "cpi rebased to Jan 2020 since 2019", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: "2020-01", time: "2019", basePoint: "2020-01", unit: "index (Jan 2020 = 100)" },
  { q: "cpi relative to 2019 (2019 = 100)", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: "2019", unit: "index (2019 = 100)" },
  { q: "cpi indexed to 2015-06 since 2015", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: "2015-06", time: "2015", basePoint: "2015-06", unit: "index (Jun 2015 = 100)" },
  { q: "cpi index 2015-Q2 = 100 since 2015", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: "2015-Q2", time: "2015", basePoint: "2015-04" },
  { q: "cpi indexed to 2015-06-01 since 2015", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: "2015-06-01", time: "2015", basePoint: "2015-06" },
  { q: "cpi percent change relative to 2019", status: "ok", pid: "18100004",
    transform: "pct_change_yoy", indexBase: null, time: "5Y" },
  { q: "cpi indexed", status: "ok", pid: "18100004", transform: "index_first",
    indexBase: null, firstIndex100: true, unit: "index (first = 100)" },
  // A city is shown individually, never added to territory totals or a ratio group.
  { q: "gasoline by province", status: "ok", pid: "18100004", chart: "line",
    members: ["Whitehorse", "Yellowknife", "Iqaluit"], geoMemberCount: 13,
    publishedPlaces: ["Whitehorse", "Yellowknife"], unpublishedPlaces: ["Iqaluit"],
    warningCodes: ["territory_proxy", "no_data"],
    warningText: "Territories are shown by their capital city (Whitehorse, Yellowknife, Iqaluit); this table does not publish territory totals." },
  { q: "gasoline by provinces and territories", status: "ok", pid: "18100004",
    members: ["Whitehorse", "Yellowknife", "Iqaluit"], geoMemberCount: 13,
    unpublishedPlaces: ["Iqaluit"], warningCodes: ["territory_proxy", "no_data"] },
  { q: "gasoline by provinces only", status: "ok", pid: "18100004", minSeries: 10, maxSeries: 10,
    excludedMembers: ["Whitehorse", "Yellowknife", "Iqaluit"], absentWarningCodes: ["territory_proxy"] },
  { q: "cpi in Yukon", status: "ok", pid: "18100004", fixedPlace: "Whitehorse, Yukon",
    members: ["Whitehorse"], warningCodes: ["territory_proxy"], warnings: [] },
  { q: "cpi in Nunavut", status: "ok", pid: "18100004", fixedPlace: "Iqaluit, Nunavut",
    members: ["Iqaluit"], warningCodes: ["territory_proxy"], warnings: [] },
  { q: "sum of provincial gasoline by province", status: "ok",
    excludedMembers: ["Whitehorse", "Yellowknife", "Iqaluit"], absentWarningCodes: ["territory_proxy"] },
  { q: "cpi provinces vs territories", status: "ok", pid: "18100004",
    groups: ["Provinces"], warningCodes: ["group_missing"], absentWarningCodes: ["territory_proxy"],
    excludedMembers: ["Whitehorse", "Yellowknife", "Iqaluit"] },
  { q: "employment in goods producing vs service producing industries by province as stacked bars",
    status: "ok", pid: "14100201", chart: "stacked_bar", transform: "level",
    xKind: "category", xDimension: "Geography", minCategories: 10, minSeries: 2, warnings: [] },
  { q: "rent inflation Toronto vs Montreal", status: "ok", pid: "18100004",
    members: ["Toronto", "Montréal", "Rented accommodation"], chart: "line",
    transform: "pct_change_yoy", minSeries: 2, warnings: [] },
  { q: "population by province line chart", status: "ok", pid: "17100009",
    chart: "line", xKind: "time", use: "series", time: "5Y", minSeries: 10, minPeriods: 2 },
  { q: "population by province as a bar chart", status: "ok", pid: "17100009",
    chart: "bar", xKind: "category", time: "latest", minCategories: 10, maxPeriods: 1 },
  { q: "population by province as a column chart", status: "ok", pid: "17100009",
    chart: "bar", horizontal: false, xKind: "category", time: "latest", minCategories: 10, maxPeriods: 1 },
  { q: "population by province as a horizontal bar chart", status: "ok", pid: "17100009",
    chart: "bar", horizontal: true, xKind: "category", time: "latest", minCategories: 10, maxPeriods: 1 },
  { q: "population by province as an area chart", status: "ok", pid: "17100009",
    chart: "area", xKind: "time", time: "5Y", minSeries: 10, minPeriods: 2 },
  { q: "population by province as a stacked area chart", status: "ok", pid: "17100009",
    chart: "stacked_area", xKind: "time", time: "5Y", minSeries: 10, minPeriods: 2 },
  { q: "population by province as a stacked column chart", status: "ok", pid: "17100009",
    chart: "stacked_bar", xKind: "category", time: "latest", minCategories: 10, maxPeriods: 1 },
  { q: "unemployment rate by province as a bar chart", status: "ok", pid: "14100287",
    chart: "bar", transform: "level", xKind: "category", time: "latest", minCategories: 10, maxPeriods: 1 },
  { q: "gas vs. food cost over time past 1yr", status: "ok", pid: "18100004",
    members: ["Gasoline", "Food"], chart: "line", transform: "level", xKind: "time", time: "1Y", minSeries: 2, minPeriods: 12, maxPeriods: 12 },
  { q: "gas vs. food cost over time past 2yr", status: "ok", pid: "18100004",
    members: ["Gasoline", "Food"], chart: "line", transform: "level", xKind: "time", time: "2Y", minSeries: 2, minPeriods: 24, maxPeriods: 24 },
  { q: "food vs. shelter inflation past 3yr", status: "ok", pid: "18100004",
    members: ["Food", "Shelter"], chart: "line", transform: "pct_change_yoy", time: "2023", minSeries: 2, minPeriods: 2 },
  { q: "population of saskatoon by age", status: "ok", pid: "98100030",
    chart: "bar", transform: "level", xKind: "category", xDimension: "Broad age groups",
    fixedPlace: "Saskatoon (CMA), Sask.", time: "latest", minCategories: 3, maxPeriods: 1, maxLayers: 1 },
  { q: "rent in toronto since 2015", status: "ok", pid: "18100004",
    members: ["Rented accommodation", "Toronto, Ontario"], chart: "line", transform: "level",
    time: "2015", openEnded: true, minPeriods: 20 },
  { q: "population by province in 2021", status: "ok", pid: "17100009",
    chart: "bar", xKind: "category", time: "2021", minCategories: 10, maxPeriods: 1 },
  { q: "population by province latest", status: "ok", pid: "17100009",
    chart: "bar", xKind: "category", time: "latest", minCategories: 10, maxPeriods: 1 },
  { q: "cpi all time", status: "ok", pid: "18100004",
    chart: "line", transform: "level", time: "max", minPeriods: 1200 },
  { q: "cpi % change over 1 year", status: "ok", pid: "18100004",
    chart: "line", transform: "pct_change_yoy", time: "5Y" },
  { q: "population by province as a pie chart", status: "ok", pid: "17100009",
    chart: "bar", xKind: "category", warningCodes: ["chart_fallback"] },
  { q: "population by province as a table", status: "ok", pid: "17100009",
    chart: "bar", xKind: "category", warningCodes: ["chart_fallback"] },
  { q: "cpi by province as a stacked bar chart", status: "ok", pid: "18100004",
    chart: "bar", xKind: "category", warningCodes: ["chart_fallback"] },
  { q: "unemployment rate change by province past 2 years as a pie chart", status: "ok", pid: "14100287",
    chart: "bar", transform: "pct_change_window", xKind: "category",
    warningCodes: ["chart_fallback"], warningText: "negative values" },
  // Pump prices: the current self-serve regular series, not the discontinued full-serve default.
  { q: "gas price", status: "ok", pid: "18100001", members: ["Canada", "Regular unleaded gasoline at self service filling stations"],
    chart: "line" },
  { q: "gas prices in toronto", status: "ok", pid: "18100001", members: ["Toronto, Ontario"] },
  { q: "gas inflation", status: "ok", pid: "18100004", product: "Gasoline", transform: "pct_change_yoy" },
  // Distributions: parts in member order, without summary members such as a median.
  { q: "income groups", status: "ok", pid: "98100065", chart: "bar", xKind: "category",
    excludedMembers: ["Median after-tax income ($)"], minCategories: 17 },
  { q: "income percentiles", status: "ok", pid: "11100193", chart: "bar", time: "latest", xKind: "category",
    leadingCategories: ["Lowest decile", "Second decile", "Third decile"], minCategories: 10, titleContains: "Average income · Adjusted after-tax income" },
  { q: "income by decile canada", status: "ok", pid: "11100193", chart: "bar", xKind: "category", minCategories: 10 },
  { q: "wealth by quintile", status: "ok", pid: "11100049", chart: "bar", xKind: "category",
    leadingCategories: ["Lowest net worth quintile", "Second net worth quintile", "Middle net worth quintile"] },
  { q: "population by age group", status: "ok", pid: "17100005", chart: "bar", time: "latest", xKind: "category",
    leadingCategories: ["0 to 4 years", "5 to 9 years", "10 to 14 years"], excludedMembers: ["All ages", "Median age"] },
  { q: "population by sex", status: "ok", pid: "17100005", minSeries: 2 },
];
// Four meaning-preserving variations per home demo: typo, time, connector, punctuation-free.
const demoVariantSets: { expected: Omit<Case, "q">; typo: string; time: string; connector: string; bare: string }[] = [
  { expected: { status: "ok", layers: ["18100004"], transform: "level" },
    typo: "cost of living by provicne, past 10 years",
    time: "cost of living by province since 2016",
    connector: "cost of living and consumer prices by province, past 10 years",
    bare: "cost of living by province past 10 years" },
  { expected: { status: "ok", layers: ["18100004"], transform: "pct_change_yoy" },
    typo: "gas vs. food inflation, Ontairo, rate of change",
    time: "gas vs. food inflation, ontario, rate of change since 2020",
    connector: "gas compared to food inflation, ontario, rate of change",
    bare: "gas vs food inflation ontario rate of change" },
  { expected: { status: "ok", layers: ["17100009", "18100004"], transform: "index_first" },
    typo: "populaton vs inflation since 2018 indexed to 2015",
    time: "population vs inflation past 10 years indexed to 2015",
    connector: "population compared to inflation since 2018 indexed to 2015",
    bare: "population versus inflation since 2018 indexed to 2015" },
  { expected: { status: "ok", layers: ["14100287", "14100292"], groups: ["Provinces", "Territories"],
      titleContains: "Provinces vs Territories", transform: "level" },
    typo: "unemployment rate, provinces vs. territoriez",
    time: "unemployment rate, provinces vs territories, past 10 years",
    connector: "unemployment rate, provinces and territories",
    bare: "unemployment rate provinces vs territories" },
  { expected: { status: "ok", layers: ["17100009"], groups: ["Prairies", "Atlantic provinces"],
      titleContains: "Prairies vs Atlantic provinces", transform: "pct_change_yoy" },
    typo: "population growth, praries vs. atlantic, since 2000",
    time: "population growth, prairies vs. atlantic, past 10 years",
    connector: "population growth, prairies compared to atlantic, since 2000",
    bare: "population growth prairies vs atlantic since 2000" },
  { expected: { status: "ok", layers: ["14100201"], transform: "level" },
    typo: "employment in goods producing vs service producing industries by provicne as stacked bars",
    time: "employment in goods producing vs service producing industries by province as stacked bars since 2020",
    connector: "employment in goods producing and service producing industries by province as stacked bars",
    bare: "employment in goods producing vs service producing industries by province stacked bars" },
  { expected: { status: "ok", layers: ["18100004"], transform: "pct_change_yoy" },
    typo: "rent inflation Tornto vs Montreal",
    time: "rent inflation Toronto vs Montreal past 5 years",
    connector: "rent inflation Toronto compared to Montreal",
    bare: "Montreal vs Toronto rent inflation" },
  { expected: { status: "ok", layers: ["36100434"], transform: "pct_change_yoy" },
    typo: "real gdp, year-over-year change, past 20 yeers",
    time: "real gdp, year-over-year change, since 2005",
    connector: "real gdp, year-over-year change over the past 20 years",
    bare: "real gdp year over year change past 20 years" },
  { expected: { status: "ok", layers: ["13100932"], transform: "level", chart: "bar" },
    typo: "deaths by cause in Ontairo",
    time: "deaths by cause in ontario since 2020",
    connector: "deaths by cause for ontario",
    bare: "causes of death in ontario" },
  { expected: { status: "ok", layers: ["14100220"], transform: "level" },
    typo: "avrage weekly earnings by industry",
    time: "average weekly earnings by industry since 2020",
    connector: "average weekly earnings across industries",
    bare: "weekly earnings by industry" },
];
const demoVariants: Case[] = demoVariantSets.flatMap(({ expected, typo, time, connector, bare }) =>
  [typo, time, connector, bare].map((q) => ({ q, ...expected })));


const split = process.argv.find((arg) => arg.startsWith("--split="))?.slice(8);
const onlyCase = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
if (split !== "tuned" && split !== "heldout" && split !== "fresh" && split !== "census" &&
  split !== "patterns" && split !== "regressions" && split !== "demo-variants" && split !== "all")
  throw new Error("Use --split=tuned|heldout|fresh|census|patterns|regressions|demo-variants|all");
const groups = split === "all" ? { tuned, heldout, fresh, census, patterns, regressions, "demo-variants": demoVariants }
  : { [split]: split === "tuned" ? tuned : split === "heldout" ? heldout : split === "fresh" ? fresh
    : split === "census" ? census : split === "patterns" ? patterns : split === "demo-variants" ? demoVariants : regressions };
const { db } = await openFromEnv();
let failed = false;
const overall = { latency: [] as number[], cases: 0, behavior: 0, status: 0, table: 0, tableCount: 0 };
try {
  for (const [name, cases] of Object.entries(groups)) {
    const rows = onlyCase ? cases.filter((item) => item.q === onlyCase) : cases;
    if (!rows.length) continue;
    const latency: number[] = [];
    let statusCorrect = 0, tableCorrect = 0, tableCount = 0, behaviorCorrect = 0;
    for (const item of rows) {
      const start = performance.now();
      const actual = await planQuery(db, item.q, { view: true });
      const ms = Math.round(performance.now() - start);
      latency.push(ms);
      const pid = actual.spec?.layers[0]?.pid;
      const issues: string[] = [];
      if (actual.status === item.status) statusCorrect++; else issues.push(`status=${actual.status}`);
      if (item.planReason !== undefined && actual.reason !== (item.planReason ?? undefined))
        issues.push(`planReason:${actual.reason}`);
      if (item.noMatchReason && !actual.reason?.includes(item.noMatchReason))
        issues.push(`noMatchReason:${actual.reason}`);
      if (item.status === "ok") {
        if (item.pid) {
          tableCount++;
          if (pid === item.pid) tableCorrect++; else issues.push(`pid=${pid}`);
        }
        const spec = actual.spec;
        const view = actual.view;
        if (!spec || !view) issues.push("view missing");
        else {
          if (!view.series.some((series) => series.points.some((point) => point[2] !== null))) issues.push("no published values");
          if (view.warnings.some((warning) => warning.code === "no_data") &&
            !item.unpublishedPlaces?.length && !item.unpublishedCoordinates?.length) issues.push("no_data warning");
          const labels = [...view.series.flatMap((series) => series.coordinate.map((coordinate) => coordinate.label.toLowerCase())),
            ...(view.categories ?? []).map((category) => category.toLowerCase())];
          for (const label of item.members ?? []) if (!labels.some((visible) =>
            visible === label.toLowerCase() || visible.startsWith(`${label.toLowerCase()},`))) issues.push(`member:${label}`);
          for (const label of item.excludedMembers ?? []) if (labels.some((visible) =>
            visible === label.toLowerCase() || visible.startsWith(`${label.toLowerCase()},`))) issues.push(`unexpectedMember:${label}`);
          if (item.product && view.series.some((series) => !series.coordinate.some((coordinate) =>
            coordinate.dimension === "Products and product groups" && coordinate.label === item.product)))
            issues.push(`product:${item.product}`);
          for (const place of item.unpublishedPlaces ?? []) {
            const selected = view.series.filter((series) => series.coordinate.some((coordinate) =>
              coordinate.dimension === "Geography" && (coordinate.label === place || coordinate.label.startsWith(`${place},`))));
            if (!selected.length || selected.some((series) => !series.unpublished || series.points.some((point) => point[2] !== null)))
              issues.push(`unpublished:${place}`);
          }
          for (const place of item.publishedPlaces ?? []) {
            const selected = view.series.filter((series) => series.coordinate.some((coordinate) =>
              coordinate.dimension === "Geography" && (coordinate.label === place || coordinate.label.startsWith(`${place},`))));
            if (!selected.length || selected.some((series) => series.unpublished || !series.points.some((point) => point[2] !== null)))
              issues.push(`published:${place}`);
          }
          for (const { dimension, label } of item.unpublishedCoordinates ?? []) {
            const selected = view.series.filter((series) => series.coordinate.some((coordinate) =>
              coordinate.dimension === dimension && coordinate.label === label));
            if (!selected.length || selected.some((series) => !series.unpublished || series.points.some((point) => point[2] !== null)))
              issues.push(`unpublished:${dimension}:${label}`);
          }
          for (const { dimension, label } of item.publishedCoordinates ?? []) {
            const selected = view.series.filter((series) => series.coordinate.some((coordinate) =>
              coordinate.dimension === dimension && coordinate.label === label));
            if (!selected.length || selected.some((series) => series.unpublished || !series.points.some((point) => point[2] !== null)))
              issues.push(`published:${dimension}:${label}`);
          }
          if (item.gapNote && !view.gap_note?.includes(item.gapNote)) issues.push(`gapNote:${view.gap_note}`);
          if (item.layers) {
            const ordered = spec.layers.map(({ pid }) => pid);
            if (ordered.length !== item.layers.length || ordered.some((pid, i) => pid !== item.layers![i]))
              issues.push(`layerOrder:${ordered.join(",")}`);
          }
          if (item.maxLayers && spec.layers.length > item.maxLayers) issues.push(`layers:${spec.layers.length}`);
          if (item.measure) {
            const measures = [...new Set(view.series.flatMap((series) => series.coordinate
              .filter((coordinate) => coordinate.dimension === "Labour force characteristics").map((coordinate) => coordinate.label)))];
            if (measures.length !== 1 || measures[0] !== item.measure) issues.push(`measure:${JSON.stringify(measures)}`);
          }
          if (item.chart && spec.chart.type !== item.chart) issues.push(`chart:${spec.chart.type}`);
          if (item.titleContains && !view.title.includes(item.titleContains))
            issues.push(`title:${view.title}`);
          if (item.horizontal !== undefined && spec.chart.horizontal !== item.horizontal) issues.push(`horizontal:${spec.chart.horizontal}`);
          if (item.xKind && view.x.kind !== item.xKind) issues.push(`x:${view.x.kind}`);
          if (item.transform && spec.transform !== item.transform) issues.push(`transform:${spec.transform}`);
          if (item.indexBase !== undefined && spec.index_base !== (item.indexBase ?? undefined))
            issues.push(`indexBase:${spec.index_base}`);
          if (item.basePoint && view.series.some((series) => {
            const base = series.points.find((point) => point[1].startsWith(item.basePoint!) && point[2] !== null);
            return !base || base[2] !== 100;
          })) issues.push(`basePoint:${item.basePoint}`);
          if (item.firstIndex100 && view.series.some((series) =>
            series.points.find((point) => point[2] !== null)?.[2] !== 100)) issues.push("firstIndex100");
          if (item.outsideBase && (!view.period.from || !spec.index_base ||
            view.period.from.slice(0, 4) <= spec.index_base.slice(0, 4) ||
            view.series.some((series) => series.points.find((point) => point[2] !== null)?.[2] === 100)))
            issues.push("outsideBase");
          if (item.unit && view.series.some((series) => series.unit !== item.unit))
            issues.push(`units:${JSON.stringify([...new Set(view.series.map((series) => series.unit))])}`);
          if (item.axes !== undefined && view.axes.length !== item.axes) issues.push(`axes:${view.axes.length}`);
          if (item.xDimension && !view.x.dimension?.startsWith(item.xDimension))
            issues.push(`xDimension:${view.x.dimension}`);
          if (item.fixedPlace && !view.series.every((series) => series.coordinate.some((coordinate) =>
            /^(?:Geography|Geographic name)$/.test(coordinate.dimension) &&
            spec.layers[0]!.dims[String(coordinate.dimension_id)]?.use === "fixed" &&
            (coordinate.label === item.fixedPlace || coordinate.label.startsWith(`${item.fixedPlace} (`)))))
            issues.push(`fixedPlace:${item.fixedPlace}`);
          if (item.time && !(["latest", "max"].includes(item.time) || item.time.endsWith("Y")
            ? spec.time.preset === item.time : spec.time.from?.startsWith(item.time))) issues.push(`time:${JSON.stringify(spec.time)}`);
          if (item.openEnded && spec.time.to) issues.push(`time:unexpected-end-${spec.time.to}`);
          if (item.use && !Object.values(spec.layers[0]!.dims).some((dimension) => dimension.use === item.use)) issues.push(`use:${item.use}`);
          if (item.groups) {
            const labels = spec.layers.flatMap((layer) => Object.values(layer.dims)
              .flatMap((dimension) => dimension.groups?.map((group) => group.label) ?? []));
            for (const label of item.groups) if (!labels.includes(label)) issues.push(`group:${label}`);
          }
          for (const [group, count] of Object.entries(item.groupSeries ?? {})) {
            const series = view.series.filter((entry) => entry.group === group);
            if (series.length !== count || series.some((entry) => !entry.points.some((point) => point[2] !== null)))
              issues.push(`groupSeries:${group}:${series.length}`);
          }
          for (const [group, method] of Object.entries(item.groupMethods ?? {}))
            if (!view.series.some((entry) => entry.group === group && entry.group_method === method))
              issues.push(`groupMethod:${group}:${method}`);
          if (item.methodStep && !actual.steps.some((step) =>
            step.question === "group_method" && step.answer.includes(item.methodStep)))
            issues.push(`methodStep:${item.methodStep}`);
          if (item.methodStep && !spec.layers.some((layer) => layer.method_difference?.includes(item.methodStep!)))
            issues.push(`methodLayer:${item.methodStep}`);
          if (item.methodStep && !view.group_notes.some((note) => note.method_difference?.includes(item.methodStep!)))
            issues.push(`methodNote:${item.methodStep}`);
          if (item.minSeries && view.series.length < item.minSeries) issues.push(`series:${view.series.length}`);
          if (item.minPeriods || item.maxPeriods) {
            const periods = new Set(view.series.flatMap((series) =>
              series.points.filter((point) => point[2] !== null).map((point) => point[1]))).size;
            if (item.minPeriods && periods < item.minPeriods || item.maxPeriods && periods > item.maxPeriods)
              issues.push(`periods:${periods}`);
          }
          if (item.reason && !actual.steps.some((step) =>
            step.question === "chart_reason" && step.answer.includes(item.reason))) issues.push(`chartReason:${item.reason}`);
          for (const code of item.warningCodes ?? []) if (!view.warnings.some((warning) => warning.code === code))
            issues.push(`warning:${code}`);
          for (const code of item.absentWarningCodes ?? []) if (view.warnings.some((warning) => warning.code === code))
            issues.push(`unexpectedWarning:${code}`);
          if (item.warningText && !view.warnings.some((warning) => warning.message.includes(item.warningText!)))
            issues.push(`warningText:${item.warningText}`);
          if (item.maxSeries && view.series.length > item.maxSeries) issues.push(`series:${view.series.length}`);
          const geoMembers = spec.layers[0]!.dims["1"]?.members;
          if (item.geoMemberCount && (!geoMembers || !("in" in geoMembers) ||
            geoMembers.in.length !== item.geoMemberCount))
            issues.push(`geoMembers:${JSON.stringify(geoMembers)}`);
          for (const id of item.totalDimensions ?? []) {
            const dimension = spec.layers[0]!.dims[String(id)];
            if (dimension?.use !== "fixed" || !("eq" in dimension.members) || dimension.members.eq !== 1)
              issues.push(`total:${id}:${JSON.stringify(dimension)}`);
          }
          for (const place of item.missingPlaces ?? []) if (!view.warnings.some((warning) =>
            warning.code === "member_not_found" && warning.message.includes(place)))
            issues.push(`missingPlace:${place}`);
          if (item.minCategories && (view.categories?.length ?? 0) < item.minCategories) issues.push(`categories:${view.categories?.length ?? 0}`);
          if (item.orderedCategories && ((view.categories?.length ?? 0) !== item.orderedCategories.length ||
            item.orderedCategories.some((place, i) => {
              const category = view.categories?.[i];
              return category !== place && !category?.startsWith(`${place} (`);
            }))) issues.push(`categoryOrder:${JSON.stringify(view.categories)}`);
          if (item.leadingCategories && item.leadingCategories.some((label, i) => view.categories?.[i] !== label))
            issues.push(`leadingCategories:${JSON.stringify(view.categories?.slice(0, item.leadingCategories.length))}`);
          if (item.warnings && item.warnings.join() !== view.warnings.filter((warning) => warning.code === "member_not_found").map((warning) => warning.code).join()) issues.push(`warnings:${view.warnings.map((warning) => warning.code)}`);
        }
      }
      if (!issues.length) behaviorCorrect++; else failed = true;
      console.log(`${name} ${issues.length ? "FAIL" : "PASS"} ${ms}ms ${JSON.stringify(item.q)} ${issues.join(" ") || `status=${actual.status} pid=${pid ?? "-"} via=${actual.planner}`}`);
    }
    latency.sort((a, b) => a - b);
    console.log(`${name}: behavior=${behaviorCorrect}/${rows.length} status=${statusCorrect}/${rows.length} table=${tableCorrect}/${tableCount} p50=${latency[Math.floor(latency.length * .5)]}ms p95=${latency[Math.floor(latency.length * .95)]}ms`);
    overall.latency.push(...latency);
    overall.cases += rows.length;
    overall.behavior += behaviorCorrect;
    overall.status += statusCorrect;
    overall.table += tableCorrect;
    overall.tableCount += tableCount;
  }
  if (onlyCase && !overall.cases) throw new Error(`No eval case found for ${onlyCase}`);
  if (split === "all") {
    overall.latency.sort((a, b) => a - b);
    console.log(`all: behavior=${overall.behavior}/${overall.cases} status=${overall.status}/${overall.cases} ` +
      `table=${overall.table}/${overall.tableCount} p50=${overall.latency[Math.floor(overall.latency.length * .5)]}ms ` +
      `p95=${overall.latency[Math.floor(overall.latency.length * .95)]}ms`);
  }
} finally { db.close(); }
if (failed) process.exitCode = 1;
