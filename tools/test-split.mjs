/* Checks that the splitter tags source correctly, which is what decides whether a
 * rename is complete or merely partial.
 *
 * A partial rename is worse than none: the keys in an object literal get renamed
 * and the code reading them does not, so the file stops working, and it stops in a
 * way that looks like a typo rather than a bad tool run. That is exactly what
 * happened to tools/build.mjs, whose regex literals were read as strings.
 */

import { readdir, readFile } from "node:fs/promises";
import { renombrar } from "./rename-es.mjs";

const RAIZ = new URL("../", import.meta.url).pathname;

let fallos = 0;

function check(nombre, ok, detalle = "") {
  if (ok) console.log(`  ok   ${nombre}`);
  else { console.log(`  FALLO ${nombre}  --> ${detalle}`); fallos += 1; }
}

async function* ficheros(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) yield* ficheros(p);
    else if (/\.(mjs|js)$/.test(e.name)) yield p;
  }
}

console.log("  ── renombrar es idempotente: dos pasadas dan el mismo texto ──");
{
  /* The strongest statement available without running the result: renaming what
     was already renamed changes nothing. A splitter that loses track of where a
     region starts produces a different result on the second pass, because the
     tags land in different places. */
  let estables = 0;
  const inestables = [];

  for await (const ruta of ficheros(RAIZ)) {
    if (ruta.endsWith("worker.js") || ruta.endsWith("rename-es.mjs")) continue;

    const src = await readFile(ruta, "utf8");
    const rel = ruta.slice(RAIZ.length);

    const uno = renombrar(src, rel).texto;
    const dos = renombrar(uno, rel).texto;

    if (uno === dos) estables += 1;
    else inestables.push(rel);
  }

  check("todos los ficheros son estables al repetir", inestables.length === 0,
    `${inestables.length} inestables: ${inestables.slice(0, 4).join(", ")}`);
  check("se comprobaron ficheros de verdad", estables > 25, `${estables} estables`);
}

console.log("  ── una clave de objeto y su lectura se renombran juntas ──");
{
  /* This is the exact failure: `ruta:` renamed while `entry.ruta` did not. */
  const src = [
    'const FILES = [',
    '  { ruta: "../src/core.mjs", nombre: "core.mjs" },',
    '];',
    '',
    'for (const entry of FILES) {',
    '  const url = new URL(entry.ruta, import.meta.url);',
    '  entries.push({ ruta: url, nombre: entry.nombre });',
    '}',
  ].join("\n");

  const { texto } = renombrar(src, "tools/build.mjs");

  check("la clave se renombro", texto.includes("paths:"), JSON.stringify(texto));
  check("la lectura se renombro", texto.includes("entry.paths"), JSON.stringify(texto));
  check("no queda ni una ruta sin renombrar", !/\bruta\b/.test(texto), JSON.stringify(texto));
  check("no queda ni un nombre sin renombrar", !/\bnombre\b/.test(texto), JSON.stringify(texto));
}

console.log("  ── un regex con comillas y llaves no se come el resto del fichero ──");
{
  const src = [
    'function strip(code) {',
    '  return code',
    '    .replace(/import\\s*\\{[^}]*\\}\\s*from\\s*"\\.[^"]*"\\s*;/g, "")',
    '    .replace(/^export\\s+(const|let)\\b/gm, "$1");',
    '}',
    '',
    'const ruta = "despues del regex";',
    'const nombre = ruta.length;',
  ].join("\n");

  const { texto } = renombrar(src, "tools/build.mjs");

  const patron = String.raw`.replace(/import\s*\{[^}]*\}`;
  check("el regex sobrevive intacto", texto.includes(patron), JSON.stringify(texto));
  check("lo que va despues si se renombro", texto.includes("const paths = "), JSON.stringify(texto));
  check("la cadena con palabra espanola no se toca", texto.includes('"despues del regex"'), JSON.stringify(texto));
}

console.log("  ── una clase de caracteres con una barra ──");
{
  const src = 'const RE = /[^/]"/g;\nconst nombre = 2;\n';
  const { texto } = renombrar(src, "x.mjs");

  check("el patron con / dentro de [] no se corta", texto.includes("const name = 2"), JSON.stringify(texto));
}

console.log("  ── division, no regex ──");
{
  const src = 'const total = a / b / c;\nconst nombre = 3;\nconst s = "x";\n';
  const { texto } = renombrar(src, "x.mjs");

  check("la division no rompe el troceado", texto.includes("const name = 3"), JSON.stringify(texto));
  check("la cadena de despues sigue intacta", texto.includes('"x"'), JSON.stringify(texto));
}

console.log("  ── los heredados de Object.prototype no estan en el mapa ──");
{
  for (const id of ["toString", "valueOf", "constructor", "hasOwnProperty", "propertyIsEnumerable"]) {
    const { texto } = renombrar(`const ${id} = 1;`, "x.mjs");
    check(`${id} se deja quieto`, texto === `const ${id} = 1;`, texto);
  }

  const real = renombrar("x.toString() + y.valueOf();", "x.mjs").texto;
  check("las llamadas no se corrompen", real === "x.toString() + y.valueOf();", real);
}

console.log("  ── el override por fichero gana al mapa global ──");
{
  const universal = renombrar("const tipo = 1;\n", "src/universal.mjs").texto;
  const otro = renombrar("const tipo = 1;\n", "src/otro.mjs").texto;

  check("universal.mjs usa su override", universal.includes("category"), JSON.stringify(universal));
  check("otro fichero usa el global", otro.includes("kind"), JSON.stringify(otro));
}

console.log("  ── codigo antes de una plantilla anidada ──");
{
  /* `${lines.map((linea, i) => \`...\`)}`: the arrow head is code and the nested
     template is text. Getting that backwards leaves the Spanish in place and the
     ${...} referring to a name that is no longer there. */
  const src = 'const out = `${lines.map((linea, i) => `<text>${esc(linea)}</text>`).join("\\n")}`;';
  const { texto } = renombrar(src, "tools/og.mjs");

  check("el parametro se renombro", texto.includes("(line, i)"), texto);
  check("el uso interior se renombro", texto.includes("esc(line)"), texto);
  check("no queda linea Spanish", !/\blinea\b/.test(texto), texto);
  check("la plantilla anidada sigue intacta", texto.includes("`<text>"), texto);
}

console.log("  ── una URL con barras dentro de una plantilla ──");
{
  /* xmlns="http://www.w3.org/2000/svg" put a `/` in the middle of template text,
     which is where a regex-shaped reader would go wrong. */
  const src = 'const svg = `<svg xmlns="http://www.w3.org/2000/svg" w="${ANCHO}">${cuerpo}</svg>`;';
  const { texto } = renombrar(src, "tools/og.mjs");

  check("la URL no se toco", texto.includes('xmlns="http://www.w3.org/2000/svg"'), texto);
  check("lo de despues si se renombro", texto.includes("body"), texto);
}

console.log("");
console.log(fallos ? `  ${fallos} comprobaciones fallidas` : "  todas las comprobaciones pasaron");
process.exitCode = fallos ? 1 : 0;