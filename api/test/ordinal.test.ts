import assert from "node:assert/strict";
import { test } from "node:test";
import { isOrdinal } from "../public/export-layout.js";

test("income brackets with an odd median row are ordinal", () => {
  assert.equal(isOrdinal(["Under $5,000 (including loss)", "$5,000 to $9,999 ", "$10,000 to $14,999", "$15,000 to $19,999", "$20,000 to $24,999",
    "$25,000 to $29,999", "$30,000 to $34,999", "$90,000 to $99,999", "$100,000 and over", "Median after-tax income ($)"]), true);
});

test("age groups, sizes, percentiles, deciles, quintiles and top shares are ordinal", () => {
  assert.equal(isOrdinal(["15 to 24 years", "25 to 54 years", "55 to 64 years", "65 years and over"]), true);
  assert.equal(isOrdinal(["Under 15 years", "15 to 64 years", "65+"]), true);
  assert.equal(isOrdinal(["1 to 4 employees", "5 to 9 employees", "10 to 19 employees", "500 employees and over"]), true);
  assert.equal(isOrdinal(["Lowest decile", "Second decile", "Third decile", "Highest decile"]), true);
  assert.equal(isOrdinal(["Lowest quintile", "Second quintile", "Third quintile", "Fourth quintile", "Highest quintile"]), true);
  assert.equal(isOrdinal(["10th percentile", "50th percentile", "90th percentile", "Top 1%"]), true);
  assert.equal(isOrdinal(["2019", "2020", "2021", "2022"]), true);
  assert.equal(isOrdinal(["Q1 2024", "Q2 2024", "Q3 2024"]), true);
});

test("names are not ordinal", () => {
  assert.equal(isOrdinal(["Malignant neoplasms", "Major cardiovascular diseases", "Dementia", "COVID-19", "Sepsis"]), false);
  assert.equal(isOrdinal(["Mining, quarrying, and oil and gas extraction", "Retail trade", "Construction", "Finance and insurance"]), false);
  assert.equal(isOrdinal(["Ontario", "Quebec", "British Columbia", "Alberta"]), false);
  assert.equal(isOrdinal(["All-items", "Food", "Shelter", "Gasoline"]), false);
});

test("below 70 % buckets is not ordinal; too few labels is not ordinal", () => {
  assert.equal(isOrdinal(["Under $5,000", "$5,000 to $9,999", "Total", "Median", "Average"]), false);
  assert.equal(isOrdinal(["15 to 24 years"]), false);
  assert.equal(isOrdinal([]), false);
});
