#!/usr/bin/env node
// Regenerates web/lib/abi/mandate.ts straight from the compiled Solidity so the frontend ABI can
// never drift from the contracts. Drift here is what let SpendArc ship a frontend wired to a
// different contract surface than the audited one.
//
//   node scripts/sync-abi.mjs          rewrite web/lib/abi/mandate.ts
//   node scripts/sync-abi.mjs --check  exit 1 if the committed file is stale
//
// Add `npm run check:abi` to CI or a pre-commit hook to make staleness a hard failure.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outFile = resolve(repoRoot, "web", "lib", "abi", "mandate.ts");
const checkOnly = process.argv.includes("--check");

const TARGETS = [
  { contract: "MandateVault", exportName: "mandateVaultAbi" },
  { contract: "MandateVaultFactory", exportName: "mandateVaultFactoryAbi" },
];

function abiOf(contract) {
  const out = execFileSync("forge", ["inspect", contract, "abi", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // Keep the JSON compact and stable so the committed file only changes when the ABI changes.
  return JSON.stringify(JSON.parse(out));
}

const blocks = TARGETS.map(({ contract, exportName }) => {
  const json = abiOf(contract);
  return `export const ${exportName} = ${json} as const;`;
});

const contents = [
  "// AUTO-GENERATED - do not edit by hand.",
  "//",
  "// Sources:",
  TARGETS.map(t => `//   src/${t.contract}.sol  (forge inspect ${t.contract} abi --json)`).join("\n"),
  "//",
  "// Regenerate: npm run sync:abi      Fail if stale: npm run check:abi",
  "",
  ...blocks.flatMap(b => [b, ""]),
].join("\n");

if (checkOnly) {
  let current = null;
  try {
    current = readFileSync(outFile, "utf8");
  } catch {
    console.error(`sync-abi: ${outFile} is missing. Run: npm run sync:abi`);
    process.exit(1);
  }
  if (current !== contents) {
    console.error("sync-abi: web/lib/abi/mandate.ts is STALE against the contracts.");
    console.error("          Run: npm run sync:abi");
    process.exit(1);
  }
  console.log("sync-abi: ABI is up to date with src/MandateVault.sol and src/MandateVaultFactory.sol");
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, contents);
  console.log(`sync-abi: wrote ${outFile}`);
  for (const { contract } of TARGETS) console.log(`           from src/${contract}.sol`);
}