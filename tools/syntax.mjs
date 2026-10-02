/**
 * Checks that every JavaScript file in the project is syntactically valid, and
 * the generated `worker.js` as well.
 *
 * It exists because of one concrete failure: a block comment in `src/api.mjs`
 * was left unclosed and swallowed the whole `contentDisposition` function. The
 * module imported without a problem —a function declaration only breaks when
 * you call it— so `test-worker.mjs` passed, `npm run check` passed, and the
 * Worker deployed without complaining. What actually blew up was
 * `/api/download`, in production, with a `contentDisposition is not defined`
 * that no file in this project produced and which therefore could not be seen
 * in any test.
 *
 * A badly closed block comment swallows the code that comes after it, up to
 * whichever close marker comes next. Node accepts that without saying anything,
 * because a comment can swallow whatever it likes and still be a valid program:
 * if what it swallows is the body of a function, the only thing missing is that
 * function, and you might not even notice. The only thing that gives it away is
 * a parser, and that is what this does.
 *
 * `node --check` is used instead of importing the files because importing runs
 * top-level code, and a syntax check should leave no traces behind or depend on
 * the network.
 */
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = fileURLToPath(new URL(".", import.meta.url));

const run = promisify(execFile);

const failures = [];

/* The platform files are discovered instead of written by hand: adding one
   without adding it here would leave it unchecked, which is exactly what this
   file exists to prevent. */
const PLATFORMS = (await readdir(new URL("../src/platforms/", import.meta.url)))
  .filter((n) => n.endsWith(".js"))
  .sort()
  .map((n) => [`src/platforms/${n}`, `../src/platforms/${n}`]);

/* The order goes from the most deployed to the least. `worker.js` comes out of
   `src/`, so if both fail at once, the one that broke first is the `src/` one,
   and that is the one to look at. */
/* Every tool is discovered, not written out.

   The list used to be here by hand and carried four of the nine tools, so a
   `tools/nuevo.mjs` added to the check chain was never checked, and nothing said
   so: the file simply was not in the list, and a missing entry looks exactly like
   a passing one. The platform files were already discovered this way for exactly
   this reason, and the same argument applies one directory over. */
const TOOLS = readdirSync(join(here, "."))
  .filter((name) => name.endsWith(".mjs"))
  .sort()
  .map((name) => [`tools/${name}`, `./${name}`]);

const FILES = [
  ["src/core.mjs", "../src/core.mjs"],
  ...PLATFORMS,
  ["src/dispatch.mjs", "../src/dispatch.mjs"],
  ["src/universal.mjs", "../src/universal.mjs"],
  ["src/api.mjs", "../src/api.mjs"],
  ["src/worker-entry.js", "../src/worker-entry.js"],
  ["bin/cli.mjs", "../bin/cli.mjs"],
  ...TOOLS,
  ["worker.js", "../worker.js"],
];

for (const [fileName, paths] of FILES) {
  const url = new URL(paths, import.meta.url);

  try {
    await readFile(url);
  } catch {
    /* `worker.js` does not exist before the first build and that is fine. A source
       that does not exist is not: it means a rename that nothing followed, and
       skipping it quietly is how a file stops being checked without anyone
       noticing. Only the generated file is allowed to be absent. */
    if (fileName === "worker.js") {
      console.log(`  ${fileName}: not generated yet, skipped`);
      continue;
    }

    console.log(`  ${fileName}: DOES NOT EXIST`);
    failures.push(fileName);
    continue;
  }

  try {
    await run(process.execPath, ["--check", fileURLToPath(url)]);
    console.log(`  ${fileName}: syntax ok`);
  } catch (error) {
    const output = String(error.stderr || error.stdout || "").trim().split("\n");

    /* Only the first line that says where it is gets printed, because that is
       the useful one. The rest of Node's dump is noise for whoever just wants to
       fix it. */
    const where = output.find((line) => /^\s*\^|SyntaxError|\.m?js:\d+/.test(line)) ?? output[0] ?? "";

    console.log(`  ${fileName}: INVALID SYNTAX -> ${where.trim()}`);
    failures.push(fileName);
  }
}

/* Checking that a file is a well-formed program is not the same as checking
   that a group of files is one together. An `import` of a name the module next
   door does not export is a perfectly valid program that does not load, and
   there is no broken syntax to look at there: it only fails when it links.

   And that is exactly what happened with `setSecrets`: `src/worker-entry.js`
   asked `src/api.mjs` for it, which imported it but did not export it. The
   flattened build output came out fine because there everything is in the same
   file, so the deployed Worker worked while the source code did not load. The
   last link of the chain is the one imported, and the one holding all of it
   up. */
try {
  const entry = await import(new URL("../src/worker-entry.js", import.meta.url));

  console.log(`  src/worker-entry.js: loads and exposes fetch (${typeof entry.default.fetch})`);
} catch (error) {
  console.log(`  src/worker-entry.js: DOES NOT LOAD -> ${String(error.message).split("\n")[0]}`);
  failures.push("src/worker-entry.js");
}

if (failures.length) {
  console.log(`\n${failures.length} file(s) with invalid syntax: ${failures.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`${FILES.length} files, syntax ok`);
}
