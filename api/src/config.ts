import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Db, requireMount } from "./db.ts";

// api/.env (gitignored) holds local paths and TYPESAFE_API_KEY. Variables already set in the environment win.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DEFAULT_PUBLIC_ORIGIN = "https://statcan2.ca";
export const publicOrigin = () => (process.env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, "");

/** Read the environment shared by the HTTP server and the MCP server, check the mounts, and open the database. */
export async function openFromEnv() {
  const buildDir = process.env.STATCAN_BUILD;
  if (!buildDir) throw new Error("STATCAN_BUILD must point at a build directory (see BUILD.md)");
  const normalizedDir = process.env.STATCAN_NORMALIZED;
  if (!normalizedDir) throw new Error("STATCAN_NORMALIZED must point at a normalized/<id>/ directory of that build (see BUILD.md)");
  const codeSets = process.env.STATCAN_CODESETS;
  if (!codeSets) throw new Error("STATCAN_CODESETS must point at a captured codeSets.json (its .sha256 file must sit next to it)");
  const captureDir = process.env.STATCAN_CAPTURE || undefined;
  const uuid = process.env.STATCAN_UUID;
  if (uuid) {
    requireMount(buildDir, uuid);
    requireMount(normalizedDir, uuid);
    requireMount(codeSets, uuid);
    if (captureDir) requireMount(captureDir, uuid);
  }
  return { db: await Db.open(buildDir, normalizedDir, codeSets, uuid), captureDir };
}
