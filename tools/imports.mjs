/**
 * Every name a platform file uses must be one it imported, or one it defines.
 *
 * It exists because of three bugs this split introduced, all the same mistake:
 * a platform file called a name from the core that it had not imported. Nothing
 * said so. `tools/build.mjs` flattens every file into the single Worker, and
 * there the name IS in scope, so the build passed, the syntax check passed and
 * the deployed Worker worked — the bugs only existed in the source tree, and
 * only showed up as a 500 at runtime.
 *
 * That is the same shape as the `setSecrets` failure this repository already got
 * bitten by once, and it is invisible to every other check here for the same
 * reason: flattening hides exactly the mistakes that are about names.
 *
 * Two directions are checked, because both are the same bug:
 *   - used from the core but not imported: `undefined` when the source loads
 *   - imported but the core does not export it: also `undefined`
 *
 * The core's exports are the reference; nothing is hard-coded, so a new export
 * needs no change here.
 *
 *   node tools/imports.mjs
 */
import { readdir, readFile } from "node:fs/promises";

const core = await readFile(new URL("../src/core.mjs", import.meta.url), "utf8");

/** What `core.mjs` offers: every `export`ed top-level definition. */
const OFFERS = new Set(
  [...core.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]),
);

/** Everything the core defines, exported or not — to catch a non-exported one. */
const DEFINED = new Set(
  [...core.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => m[1]),
);

const platformDir = new URL("../src/platforms/", import.meta.url);
const failures = [];
let checked = 0;

for (const fileName of (await readdir(platformDir)).filter((n) => n.endsWith(".js")).sort()) {
  const src = await readFile(new URL(fileName, platformDir), "utf8");
  const lines = src.split("\n");

  /* What it imports. The braces are required: every platform file uses the named
     form, and a namespace or default import would need its own handling rather
     than being silently read as "no imports". */
  const imported = new Set(
    [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/core\.mjs"/g)]
      .flatMap((m) => m[1].split(",").map((x) => x.trim()).filter(Boolean)),
  );

  /* What it defines itself, so its own names are not reported as missing. */
  const own = new Set(
    [...src.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => m[1]),
  );

  /* Code with the comments taken out, so the prose does not count as a use.

     Stripping by line prefix is not enough and the difference matters here: a
     block comment can open in the middle of a line, where real code would
     already have started, which is what `src/platforms/facebook.js` does. A
     prefix filter therefore reads that prose as code and reports `secrets` —
     the name the prose happens to mention, and the very variable the core
     defines — as used when nothing calls it. Blocks, line comments and string
     literals are all removed, which leaves only the code. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

  const code = stripComments(src);

  const missing = [...DEFINED]
    .filter((n) => !own.has(n))
    .filter((n) => !imported.has(n))
    .filter((n) => new RegExp(`\\b${n}\\b`).test(code))
    .sort();

  /* The other direction: imported, but the core does not export it. */
  const ghost = [...imported].filter((n) => !OFFERS.has(n) && !own.has(n)).sort();

  checked++;

  for (const fileName of missing) {
    const lineNo = lines.findIndex((l) => new RegExp(`\\b${fileName}\\b`).test(l)) + 1;
    const exists = OFFERS.has(fileName)
      ? "does not import it"
      : "the core does not export it (it is declared there, so it works in the flattened Worker and not in the sources)";

    failures.push(`${fileName}: uses "${fileName}" (line ${lineNo}) and ${exists}`);
  }

  for (const fileName of ghost) {
    failures.push(`${fileName}: imports "${fileName}", which the core does not export`);
  }

  if (!missing.length && !ghost.length) {
    console.log(`  ${fileName}: ${imported.size} imported, all used and all exist`);
  }
}

if (failures.length) {
  console.log(`\n${failures.length} problem(s) in the platform imports:\n`);

  for (const f of failures) console.log(`  ${f}`);

  console.log("\nWith the flattened Worker this does not show: the names are in the same");
  console.log("scope once deployed. It only fails in the source tree.");
  process.exitCode = 1;
} else {
  console.log(`${checked} platforms: every name used is imported and exists`);
}