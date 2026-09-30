import { Db, requireMount } from "./db.ts";

/** Read the environment shared by the HTTP server and the MCP server, check the mounts, and open the database. */
export async function openFromEnv() {
  const buildDir = process.env.STATCAN_BUILD;
  if (!buildDir) throw new Error("STATCAN_BUILD must point at a build directory (see BUILD.md)");
  const codeSets = process.env.STATCAN_CODESETS;
  if (!codeSets) throw new Error("STATCAN_CODESETS must point at a captured codeSets.json (its .sha256 file must sit next to it)");
  const captureDir = process.env.STATCAN_CAPTURE || undefined;
  const uuid = process.env.STATCAN_UUID;
  if (uuid) {
    requireMount(buildDir, uuid);
    requireMount(codeSets, uuid);
    if (captureDir) requireMount(captureDir, uuid);
  }
  return { db: await Db.open(buildDir, codeSets), captureDir };
}
