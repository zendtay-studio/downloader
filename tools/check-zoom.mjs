/**
 * Checks that the dot field survives the zoom.
 *
 * It exists because of a concrete failure. The field measured itself in CSS
 * pixels, which is right at 100% and wrong everywhere else: zoomed to 25%, one
 * CSS pixel is a quarter of a physical pixel, so the dots — a radius of 1.15 —
 * were drawn at 0.29 and covered less than a whole pixel each. Seventeen
 * thousand of them, eight and a half physical pixels apart, do not read as
 * points. They weave a grey cloth over the page, and it is worse the further out
 * the zoom goes, which is the wrong way round.
 *
 * Nothing else here could see it. `tools/syntax.mjs` parses the page script and
 * is happy, `tools/test-core.mjs` covers the extractors, and the field is
 * geometric: every value it uses is a legal number at every zoom, and the only
 * thing wrong with them is how big they come out.
 *
 * So this runs the field's own code, lifted out of `index.html` verbatim, at
 * every zoom the browser can hand it, and fails when a dot ends up smaller than
 * a physical pixel or the field gets so dense that the points stop being points.
 *
 * The code is read from the page rather than restated here. A copy of the formula
 * would keep passing while the page changed underneath it, which is the exact
 * shape of the bug this is for.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** The page script, same extraction `scripts-inline.mjs` uses. */
function pageScript(html) {
  const last = html.lastIndexOf("<script>");

  if (last < 0) throw new Error("index.html has no inline <script>");

  const end = html.indexOf("</script>", last);

  if (end < 0) throw new Error("the <script> in index.html is not closed");

  return html.slice(last + "<script>".length, end);
}

/** One named statement, up to its own semicolon.
 *
 *  A separate function from `chunk` on purpose. Brace matching needs a `{` to
 *  start counting, and `const PASO = 34;` has none — so given the declaration of
 *  a design length a brace matcher runs on to the next `{` in the file, which is
 *  the inside of `FIELD`, and hands back both. That declares every length twice
 *  and the check dies with `Identifier 'PASO' has already been declared`. */
function statement(source, head) {
  const from = source.indexOf(head);

  if (from < 0) throw new Error(`index.html no longer has \`${head}\``);

  const end = source.indexOf(";", from);

  if (end < 0) throw new Error(`\`${head}\` is not closed with a semicolon`);

  return source.slice(from, end + 1);
}

/** One named chunk of the page, from its start to the matching closing brace. */
function chunk(source, head) {
  const from = source.indexOf(head);

  if (from < 0) throw new Error(`index.html no longer has \`${head}\``);

  const open = source.indexOf("{", from);

  if (open < 0) throw new Error(`\`${head}\` has no body`);

  let depth = 0;

  for (let i = open; i < source.length; i += 1) {
    const c = source[i];

    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;

      if (depth === 0) return source.slice(from, i + 1);
    }
  }

  throw new Error(`\`${head}\` is not closed`);
}

/* The design lengths as named constants, the field itself, and the two functions
   that decide how big everything is and how it is wiped. Together that is
   everything needed here, and nothing that touches the DOM. */
const source = pageScript(page);
const lifted = [
  ...["const PASO", "const RADIO", "const EMPUJE", "const ALCANCE", "const ENGORDE"].map((h) => statement(source, h)),
  chunk(source, "const FIELD"),
  chunk(source, "function measureField"),
  chunk(source, "function paintField"),
].join("\n\n");

/** Runs the lifted code at one zoom and reports what came out. */
function atZoom(dpr, width, height) {
  const calls = [];

  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => {
      /* A transform that scales, like the real one, and enough bookkeeping to see
         what `clearRect` ended up covering. A stub that ignored the transform
         would report this check as passing for the whole time the bug was there. */
      let escala = 1;

      return {
        save: () => {},
        restore: () => {},
        setTransform: (a) => {
          escala = a;
        },
        getTransform: () => ({ escala }),
        clearRect: (x, y, w, h) => calls.push({ op: "clearRect", escala, w, h }),
        beginPath: () => {},
        arc: (x, y, r) => calls.push({ op: "arc", x, y, r }),
        fill: () => {},
        set fillStyle(_v) {},
      };
    },
  };

  const sandbox = {
    window: { innerWidth: width, innerHeight: height, devicePixelRatio: dpr },
    document: { getElementById: (id) => (id === "campo" ? canvas : null) },
  };

  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${lifted}\nglobalThis.FIELD = FIELD;`, sandbox);

  /* `ctx` is assigned by the block that runs the field, not by the literal, so it
     arrives as null and `measureField` dies on it. Standing in for the DOM's job
     here rather than lifting that block too, which would drag in the pointer
     listeners and `matchMedia` to get something this file does not use. */
  sandbox.FIELD.ctx = sandbox.document.getElementById("campo").getContext("2d");

  sandbox.measureField();
  sandbox.paintField();

  const f = sandbox.FIELD;
  const limpiados = calls.filter((c) => c.op === "clearRect");
  const primero = limpiados[0];

  /* How much of the canvas the clear actually reached, in device pixels. */
  const cubierto = primero ? primero.w * primero.escala * primero.h * primero.escala : 0;
  const total = canvas.width * canvas.height;

  for (const p of f.puntos) calls.push({ op: "punto", x: p.x, y: p.y });

  return {
    dpr,
    paso: f.paso,
    radio: f.radio,
    alcance: f.alcance,
    empuje: f.empuje,
    pasoFisico: f.paso * f.dpr,
    radioFisico: f.radio * f.dpr,
    puntos: f.puntos.length,
    canvasFisico: canvas.width * canvas.height,
    limpiaTodo: cubierto >= total - 0.5,
    limpioPct: total > 0 ? Math.round((cubierto / total) * 100) : 0,
  };
}

let failures = 0;

/** Below this a dot cannot cover a pixel, and it stops being a dot. */
const RADIO_MINIMO = 0.9;

/** Below this, neighbours are close enough that the grid reads as a texture. */
const PASO_MINIMO = 20;

/** Above this, the field costs more than it is worth. At 100% it is ~1750. */
const PUNTOS_MAXIMO = 3000;

const ZOOMS = [
  { dpr: 0.25, w: 5404, h: 3604, note: "25%" },
  { dpr: 0.33, w: 4096, h: 2731, note: "33%" },
  { dpr: 0.5, w: 2697, h: 1798, note: "50%" },
  { dpr: 0.67, w: 2010, h: 1340, note: "67%" },
  { dpr: 0.75, w: 1796, h: 1197, note: "75%" },
  { dpr: 1, w: 1347, h: 898, note: "100%" },
  { dpr: 1.25, w: 1078, h: 718, note: "125%" },
  { dpr: 1.5, w: 898, h: 599, note: "150%" },
  { dpr: 2, w: 674, h: 449, note: "200%" },
  { dpr: 3, w: 449, h: 299, note: "300%" },
];

console.log("   zoom    dpr   spacing   radius   puntos   limpiado   veredicto");

for (const zoom of ZOOMS) {
  const r = atZoom(zoom.dpr, zoom.w, zoom.h);

  const problemas = [];

  if (r.radioFisico < RADIO_MINIMO) problemas.push(`radio ${r.radioFisico.toFixed(2)}px fisico`);
  if (r.pasoFisico < PASO_MINIMO) problemas.push(`spacing ${r.pasoFisico.toFixed(1)}px fisico`);
  if (r.puntos > PUNTOS_MAXIMO) problemas.push(`${r.puntos} puntos`);
  if (r.puntos === 0) problemas.push("la rejilla esta vacia");

    /* The one that mattered most and showed up last. A field that is not wiped
       whole does not draw wrong points — it draws correct points on top of the
       previous frame, so the shape is an arc of every place the point has been,
       and every geometric measurement of a single point still comes out perfect.
       That is why the size checks passed for as long as they existed. */
  if (!r.limpiaTodo) problemas.push(`solo limpia el ${r.limpioPct}% del lienzo`);

  const ok = problemas.length === 0;

  if (!ok) failures += 1;

  console.log(
    `   ${zoom.note.padEnd(6)} ${String(r.dpr).padEnd(5)} `
    + `${`${r.pasoFisico.toFixed(1)}px`.padEnd(9)} `
    + `${`${r.radioFisico.toFixed(2)}px`.padEnd(8)} `
    + `${String(r.puntos).padEnd(8)} `
    + `${`${r.limpioPct}%`.padEnd(10)} `
    + (ok ? "ok" : `MAL: ${problemas.join(", ")}`),
  );
}

/* The invariant, stated on the physical screen rather than on the page.
 *
   Comparing a zoomed-out run against a 100% one by their point counts means
   nothing unless both describe the same screen, and they do not: zooming out
   makes the CSS viewport larger to cover the same glass. So the two runs below
   are given the same physical size — one as 5404x3604 CSS at 0.25, the other as
   1347x898 at 1 — and the field has to come out the same either way. Same
   spacing, same radius, same number of points.

   It is worth stating as its own check because it fails differently from the
   ones above. Those ask whether each dot is big enough on its own, and a change
   that made the dots bigger while leaving the spacing alone passes all of them
   and still looks wrong: a coarse grid of large dots is not this field. */
const pantalla = 1347;

const conZoom = atZoom(0.25, pantalla * 4, pantalla * 0.668 * 4);
const sinZoom = atZoom(1, pantalla, pantalla * 0.668);

console.log("");

const mismaDensidad =
  Math.abs(conZoom.puntos - sinZoom.puntos) <= Math.max(2, sinZoom.puntos * 0.02)
  && Math.abs(conZoom.pasoFisico - sinZoom.pasoFisico) < 0.5
  && Math.abs(conZoom.radioFisico - sinZoom.radioFisico) < 0.05;

if (!mismaDensidad) {
  console.error(
    `   the field is not the same on screen at either zoom.\n`
    + `     25%: ${conZoom.puntos} points, ${conZoom.pasoFisico.toFixed(1)}px apart, ${conZoom.radioFisico.toFixed(2)}px radius\n`
    + `     100%: ${sinZoom.puntos} points, ${sinZoom.pasoFisico.toFixed(1)}px apart, ${sinZoom.radioFisico.toFixed(2)}px radius`,
  );
  failures += 1;
} else {
  console.log(
    `   same screen at either zoom: ${conZoom.puntos} points, `
    + `${conZoom.pasoFisico.toFixed(1)}px apart, ${conZoom.radioFisico.toFixed(2)}px radius`,
  );
}

if (failures > 0) {
  console.error(`\n   ${failures} zoom(s) render the field wrong.`);
  process.exitCode = 1;
}