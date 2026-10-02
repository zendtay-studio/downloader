/* Generates the PWA icons and the manifest, so neither is hand-maintained.
 *
 * The mark is not redrawn here: it is read out of index.html, the same place the
 * favicon lives. Three copies of one drawing is how they drift apart, and a mark
 * that is a download arrow in the tab bar and a different shape in the taskbar is
 * the kind of thing nobody reports and everybody notices.
 *
 * Two sizes, 192 and 512, which are the ones Chrome and Edge ask for, plus a
 * maskable version at 512. The maskable one is the same drawing on a canvas
 * padded to 80% of its size: a maskable icon gets its corners cropped to whatever
 * shape the platform uses — a circle on Android, a squircle on Windows — and a
 * mark that fills the frame loses its corners. Everything inside the safe zone
 * survives; the padding does not.
 *
 *   node tools/pwa.mjs           write images/icon-192.png, icon-512.png and icon-maskable.png
 *   node tools/pwa.mjs --check   fail if any of them, or the manifest, is not
 *                                what this would write
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);

/* The manifest is one value in two places — here and the <link> in index.html —
   so the link is written from here too, and the check below fails if the two
   ever say different names. */
/* The images live in `images/`, so every path here is built from this rather
   than written out. Three files in three places is how a move leaves two of them
   pointing at the old path, and a manifest whose icons 404 is not installable
   for a reason no error message mentions. */
const CARPETA = "images";

const MANIFEST = "site.webmanifest";
const NOMBRE = "Downloader";
const NOMBRE_CORTO = "Downloader";
const DESCRIPCION = "Paste a link and download video, audio or a photo from 21 platforms.";
const COLOR_TEMA = "#1B1A19";
const COLOR_FONDO = "#F5F0E6";

const html = readFileSync(new URL("index.html", ROOT), "utf8");

/* The mark, lifted from the favicon so there is one drawing. Read through to the
   first `>` of the svg so a data URI with more than one element still works. */
const favicon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];

if (!favicon?.startsWith("data:image/svg+xml,")) {
  console.error("  index.html has no inline SVG favicon to take the mark from.");
  process.exit(1);
}

const marca = decodeURIComponent(favicon.split(",").slice(1).join(","));

/** The mark alone, with its own viewBox, for a square canvas. */
function lienzo({ relleno = true, rellenoFondo = null, inset = 1 }) {
  const interior = marca.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const fondo = rellenoFondo
    ? `<rect width="${24}" height="${24}" fill="${rellenoFondo}"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">`
    + fondo
    + `<g transform="translate(${12 - 12 * inset} ${12 - 12 * inset}) scale(${inset})">${interior}</g>`
    + `</svg>`;
}

/* `-size` goes BEFORE the input, and that order is the whole trick.

   `convert` rasterises SVG at 96dpi whatever the drawing is, so a 24-unit
   viewBox arrives as 24 pixels and `-density` only gets it to 96. Asking for 512
   with `-resize` after that is a 5x upscale of a 96-pixel image, smoothed on the
   way up: the arrow came out visibly soft, and the file was five times the size
   of the crisp one, because the blur was stored rather than computed.

   Rasterising at the target size instead gives hard edges and a much smaller
   file. `-strip` keeps a timestamp out of the bytes, so two runs of the same
   input are byte-identical and the check can compare them. */
function png(destino, svg, tamano) {
  execFileSync(
    "convert",
    ["-background", "none", "-size", `${tamano}x${tamano}`, "svg:-", "-depth", "8", "-strip", destino],
    { input: svg, stdio: ["pipe", "pipe", "pipe"] },
  );
}

const ICONOS = [
  { archivo: "icon-192.png", tamano: 192, svg: lienzo({ inset: 1 }) },
  { archivo: "icon-512.png", tamano: 512, svg: lienzo({ inset: 1 }) },
  /* Padded to 80%, so the crop a maskable icon gets cannot reach the arrow. */
  { archivo: "icon-maskable.png", tamano: 512, svg: lienzo({ inset: 0.8, rellenoFondo: COLOR_TEMA }) },
];

const manifest = {
  name: NOMBRE,
  short_name: NOMBRE_CORTO,
  description: DESCRIPCION,
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "any",
  background_color: COLOR_FONDO,
  theme_color: COLOR_TEMA,
  icons: ICONOS.map((i) => ({
    src: `${CARPETA}/${i.archivo}`,
    sizes: `${i.tamano}x${i.tamano}`,
    type: "image/png",
    ...(i.archivo === "icon-maskable.png" ? { purpose: "maskable" } : {}),
  })),
};

const MANIFEST_JSON = JSON.stringify(manifest, null, 2) + "\n";

/* One tag, written here, so the name in the <link> cannot drift from the file.
   Relative, not rooted: `/site.webmanifest` is a request for the domain root,
   which is a different file as soon as the site is served from a subpath — and
   on a project page that is not a 404 on screen, it is a page that loads with a
   manifest that does not, and no message saying so. */
const ETIQUETA = `<link rel="manifest" href="${MANIFEST}">`;

function revisar(archivos) {
  const problemas = [];

  for (const [destino, contenido] of archivos) {
    if (!existsSync(new URL(destino, ROOT))) {
      problemas.push(`${destino} no existe`);
      continue;
    }

    /* As Buffer on both sides: the icons come in as Buffers and the manifest as a
       string, and `String.prototype.equals` does not exist — which is only found
       out by running it. */
    const esperado = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, "utf8");
    const actual = readFileSync(new URL(destino, ROOT));

    if (!esperado.equals(actual)) problemas.push(`${destino} no es el que se generaria`);
  }

  if (!html.includes(ETIQUETA)) {
    problemas.push(`index.html no enlaza con ${ETIQUETA}`);
  }

  return problemas;
}

const check = process.argv.includes("--check");
const forzar = process.argv.includes("--force");

/* ── what this tool wrote last time ────────────────────────────────────────────
 *
 * It regenerates three icons and rewrites the manifest, and it did that over the
 * top of three icons somebody else had made. The files were named the same and
 * the bytes were different, and a generator that overwrites whatever is in the way
 * is a generator that will do it again.
 *
 * So it keeps a record: the hash of each file as this tool last wrote it. Before
 * writing, anything already on disk that does not match the record was put there
 * by somebody else, and it stops. The manifest is a plain JSON file, committed, so
 * a fresh clone knows what the files were supposed to be.
 *
 * `--force` is the way past it, and it is not the default, because the whole point
 * is that overwriting is something you say out loud.
 */
const REGISTRO = `${CARPETA}/.generados.json`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function leerRegistro() {
  const ruta = new URL(REGISTRO, ROOT);

  if (!existsSync(ruta)) return {};

  try {
    return JSON.parse(readFileSync(ruta, "utf8"));
  } catch {
    /* A record that will not parse is treated as no record at all, which makes
       the tool refuse rather than guess. Refusing is the safe direction: the cost
       of a false alarm is a `--force`, and the cost of a false all-clear is
       somebody's file. */
    return null;
  }
}

function escribirRegistro(entradas) {
  writeFileSync(
    new URL(REGISTRO, ROOT),
    JSON.stringify(entradas, null, 2) + "\n",
  );
}

/** Files on disk that this tool did not write, and so must not overwrite. */
function intrusos(esperados, registro) {
  const hallazgos = [];

  for (const [destino, contenido] of esperados) {
    const ruta = new URL(destino, ROOT);

    if (!existsSync(ruta)) continue;

    const enDisco = sha256(readFileSync(ruta));
    const anotado = registro?.[destino];

    if (anotado === enDisco) continue;          // ours, unchanged: safe

    hallazgos.push({
      destino,
      motivo: anotado === undefined
        ? "no aparece en el registro de lo que genera esta herramienta"
        : "cambio desde la ultima vez que lo genero esta herramienta",
    });
  }

  return hallazgos;
}

/* Everything this tool writes, as `[ruta, bytes]`. One list, so the check and the
   write can never disagree about which files are involved. */
async function generar(dir) {
  for (const icono of ICONOS) {
    png(join(dir, icono.archivo), icono.svg, icono.tamano);
  }

  return [
    ...ICONOS.map((i) => [`${CARPETA}/${i.archivo}`, readFileSync(join(dir, i.archivo))]),
    [MANIFEST, Buffer.from(MANIFEST_JSON, "utf8")],
  ];
}

if (check) {
  const dir = mkdtempSync(join(tmpdir(), "downloader-pwa-"));

  try {
    /* Written first, then compared: `revisar` reads the temporary files, and
       reading before writing them finds nothing there.

       `revisar` hands back messages, not pairs. Destructuring them as
       `[archivo, contenido]` took the second *character* of each message, so a
       stale manifest printed as `i` and said nothing about what was wrong. */
    const esperados = await generar(dir);

    const problemas = revisar(esperados);
    const registro = leerRegistro();

    /* The registry is checked too, or it drifts silently: the files match, the
       record of them does not, and the next write refuses forever on a file that
       is perfectly fine. */
    if (registro !== null) {
      const anotado = {};

      for (const [destino, contenido] of esperados) {
        if (existsSync(new URL(destino, ROOT))) {
          anotado[destino] = sha256(readFileSync(new URL(destino, ROOT)));
        }
      }

      if (JSON.stringify(anotado) !== JSON.stringify(registro)) {
        problemas.push(`${REGISTRO} no dice lo que hay en disco ahora`);
      }
    } else {
      problemas.push(`${REGISTRO} no existe o no se puede leer`);
    }

    if (problemas.length) {
      console.error("   Los iconos no estan al dia:");
      for (const p of problemas) console.error(`     ${p}`);
      console.error("\n   Regenera con:  node tools/pwa.mjs");
      process.exit(1);
    }

    console.log(`   PWA al dia: ${ICONOS.length} iconos y ${MANIFEST}, enlazados desde index.html`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  const dir = mkdtempSync(join(tmpdir(), "downloader-pwa-"));

  try {
    const esperados = await generar(dir);
    const registro = leerRegistro();
    const ajenados = intrusos(esperados, registro);

    if (ajenados.length && !forzar) {
      console.error("   No se escribe: estos ficheros no los genero esta herramienta:");
      for (const a of ajenados) {
        console.error(`     ${a.destino}  (${a.motivo})`);
      }
      console.error("\n   Sobrescribirlos es justo lo que hizo esto antes. Si es lo que quieres:");
      console.error("     node tools/pwa.mjs --force");
      process.exit(1);
    }

    const entradas = {};

    for (const [destino, contenido] of esperados) {
      writeFileSync(fileURLToPath(new URL(destino, ROOT)), contenido);
      entradas[destino] = sha256(contenido);
    }

    escribirRegistro(entradas);

    for (const [destino, contenido] of esperados) {
      const tam = ICONOS.find((i) => destino.endsWith(i.archivo));

      console.log(`   ${destino}: ${tam ? `${tam.tamano}x${tam.tamano}, ` : ""}${contenido.length} bytes`);
    }

    console.log(`   ${REGISTRO}: ${Object.keys(entradas).length} hashes anotados`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}