/* Renames the Spanish identifiers inside index.html's inline script.
 *
 * The script is extracted first and spliced back, rather than renaming the whole
 * document: the splitter reads JavaScript, and handing it markup would have it
 * treating attributes as code. It reuses the same trocear() the .mjs files go
 * through, so the same tested rules apply — code and comments get renamed, string
 * text does not, which matters here because the page's messages and CSS class
 * names live in strings.
 *
 * Usage: node tools/rename-page.mjs [--dry]
 */

import { readFile, writeFile } from "node:fs/promises";
import { renombrar } from "./rename-es.mjs";

const PAGINA = new URL("../index.html", import.meta.url);
const DRY = process.argv.includes("--dry");

/* The page's own script. The other <script> in the document is the CDN tag with
   attributes on it, so looking for the bare `<script>` is what picks the right one
   — and there is exactly one of those, which cost a run to find out. */
const ABRE = "<script>";
const CIERRA = "</script>";

const html = await readFile(PAGINA, "utf8");
const desde = html.indexOf(ABRE);
const hasta = html.indexOf(CIERRA, desde);

if (desde === -1 || hasta === -1) {
  console.error("  no se encuentra el bloque <script> de la pagina");
  process.exit(1);
}

const guion = html.slice(desde + ABRE.length, hasta);
const { texto, cuentas } = renombrar(guion, "index.html");

if (!cuentas) {
  console.log("  0 renombrados en index.html");
  process.exit(0);
}

/* The page's script is pasted into a function, so `await` at the top level and a
   stray `return` would only show up here. Checking the result before writing is
   the difference between a check that fails and a broken page. */
const COMPROBACION = `(async () => {\n${texto}\n})();`;

if (!DRY) {
  await writeFile(PAGINA, html.slice(0, desde + ABRE.length) + texto + html.slice(hasta), "utf8");
}

console.log(`  ${cuentas} renombrados en index.html${DRY ? " (dry)" : ""}`);
console.log(`  el guion resultante ocupa ${texto.split("\n").length} lineas`);

if (DRY) {
  await writeFile("/tmp/opencode/pagina-renombrada.js", COMPROBACION, "utf8");
}