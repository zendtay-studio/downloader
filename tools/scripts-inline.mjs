/**
 * Checks that the `<script>` inside `index.html` parses.
 *
 * Needed because a syntax error in an inline script **raises nothing in the
 * browser**: the page loads, looks complete, and the only symptom is that a
 * button, a menu or the list stops working. This really happened: a comment
 * terminator placed inside another comment left loose text behind and the
 * backgrounds menu came up empty without a word.
 *
 * Extracts the last `<script>` without `src` (the page one; the video.js tag has
 * `src` and is skipped) and pipes it through `node --check`, which parses without
 * running. A temp file is needed because `node --check` only takes a path.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** The page script: the last one, and the only one without `src`. */
function pageScript(html) {
  const last = html.lastIndexOf("<script>");

  if (last < 0) throw new Error("index.html has no inline <script>");

  const end = html.indexOf("</script>", last);

  if (end < 0) throw new Error("the <script> in index.html is not closed");

  return html.slice(last + "<script>".length, end);
}

const body = pageScript(page);
const dir = mkdtempSync(join(tmpdir(), "downloader-"));
/* `.js` and not `.mjs`, and that is the whole point of this tool.

   The page's `<script>` has no `type="module"`, so the browser parses it as a
   classic script. `node --check` on a `.mjs` file parses it as a module, and the
   two disagree about exactly the thing this tool exists to catch: a top-level
   `await` is legal in a module and a syntax error in a classic script, so a page
   that passed here would fail to load in every browser. The engine's own wording
   for it is "await is only valid in async functions and the top level bodies of
   modules".

   `.cjs` rather than `.js`, and that is not a detail. Node 22 parses an ambiguous
   `.js` as CommonJS, and when that fails it retries as a module, so a top-level
   `await` is quietly accepted and this tool reports it as fine. `.cjs` is CommonJS
   and stays there: it rejects the `await` the browser would reject, and it accepts
   `with` the browser accepts. Both directions were checked, because a check that
   only catches one of them is a check that would be happy to invent the other. */
const temp = join(dir, "inline.cjs");

try {
  writeFileSync(temp, body, "utf8");
  execFileSync(process.execPath, ["--check", temp], { stdio: "pipe" });
  console.log(`   ${body.length} bytes of JavaScript, syntax OK`);
} catch (error) {
  const detail = (error.stderr?.toString() ?? error.message).split("\n").slice(0, 6).join("\n");
  console.error(`   ${detail}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
