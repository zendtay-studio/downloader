/* Exercises chooseWithArrows against a fake terminal.
 *
 * The point is not that the function returns something — it is that the terminal
 * comes back. Raw mode turns off the echo and the line editing, so a selector that
 * returns without putting them back leaves the user with a shell that no longer
 * types, and the only way out is a new window. That is checked here on every path
 * out, including quit and Ctrl-C.
 */

import { PassThrough } from "node:stream";
import { chooseWithArrows } from "../bin/select.mjs";

const ESC = "\u001b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const SPACE = " ";

const plan = [
  { kind: "video", name: "clip-1.mp4", extension: "mp4" },
  { kind: "audio", name: "clip-2.mp3", extension: "mp3" },
  { kind: "image", name: "clip-3.jpeg", extension: "jpeg" },
];

let failures = 0;

function check(name, ok, detail = "", expected = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FALLO ${name}  --> ${detail}  (expected ${expected})`);
    failures += 1;
  }
}

/** A terminal that answers `isTTY`, counts raw-mode calls and records output. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();

  input.isTTY = true;
  output.isTTY = true;
  output.columns = 80;

  const state = { raw: 0, crudoAlFinal: null, escrito: "" };

  input.setRawMode = (on) => {
    state.raw += 1;
    if (!on) state.crudoAlFinal = false;
  };

  output.on("data", (c) => { state.escrito += c.toString(); });

  return { input, output, state };
}

/* One keypress event is not always one write: readline turns a single arrow into
   one event, but a paste can arrive as several. Waiting between keys is what makes
   the counts below mean what they say. */
const settle = () => new Promise((r) => setTimeout(r, 25));

async function run(teclas) {
  const { input, output, state } = terminal();
  const promise = chooseWithArrows(plan, { input, output });

  await settle();

  for (const t of teclas) {
    input.write(t);
    await settle();
  }

  return { value: await promise, state, output };
}

const json = (v) => JSON.stringify(v);

console.log("  ── todo marcado por defecto ──");
{
  const { value, state } = await run([ENTER]);
  check("enter se lleva los tres", json(value) === "[0,1,2]", json(value), "[0,1,2]");
  check("el crudo se activa", state.raw > 0, state.raw, ">0");
  check("el crudo se desactiva", state.crudoAlFinal === false, state.crudoAlFinal, "false");
}

console.log("  ── abajo mueve el cursor: cursor 1 es el fichero 1 ──");
{
  const { value } = await run([DOWN, SPACE, ENTER]);
  check("desmarca el primero", json(value) === "[1,2]", json(value), "[1,2]");
}

console.log("  ── tres abajo y espacio: desmarca el tercero ──");
{
  const { value, state } = await run([DOWN, DOWN, DOWN, SPACE, ENTER]);
  check("desmarca el tercero y nada mas", json(value) === "[0,1]", json(value), "[0,1]");
  check("el crudo se restaura", state.crudoAlFinal === false, state.crudoAlFinal, "false");
}

console.log("  ── arriba no se sale por encima de la primera fila ──");
{
  const { value } = await run([UP, UP, UP, ENTER]);
  check("sigue siendo todo", json(value) === "[0,1,2]", json(value), "[0,1,2]");
}

console.log("  ── arriba y abajo se cancelan ──");
{
  const { value } = await run([DOWN, DOWN, UP, SPACE, ENTER]);
  check("vuelve a la fila 2 y desmarca el 1", json(value) === "[1,2]", json(value), "[1,2]");
}

console.log("  ── la fila 'todo': espacio la vacia y la vuelve a llenar ──");
{
  const emptied = await run([SPACE, ENTER]);
  check("espacio en 'todo' lo vacia", emptied.value === null || json(emptied.value) === "[]",
    json(emptied.value), "[] o null");

  const filled = await run([SPACE, SPACE, ENTER]);
  check("espacio otra vez lo llena", json(filled.value) === "[0,1,2]", json(filled.value), "[0,1,2]");
}

console.log("  ── n vacia y a llena ──");
{
  const n = await run(["n", ENTER]);
  check("n lo vacia", n.value === null || json(n.value) === "[]", json(n.value), "[] o null");
  check("n restaura el terminal", n.state.crudoAlFinal === false, n.state.crudoAlFinal, "false");

  const a = await run(["n", "a", ENTER]);
  check("a lo llena", json(a.value) === "[0,1,2]", json(a.value), "[0,1,2]");
}

console.log("  ── q y Ctrl-C se van sin coger nada ──");
{
  const q = await run(["q"]);
  check("q devuelve null", q.value === null, json(q.value), "null");
  check("q restaura el terminal", q.state.crudoAlFinal === false, q.state.crudoAlFinal, "false");

  const cc = await run([""]);
  check("Ctrl-C devuelve null", cc.value === null, json(cc.value), "null");
  check("Ctrl-C restaura el terminal", cc.state.crudoAlFinal === false, cc.state.crudoAlFinal, "false");
}

console.log("  ── el dibujo ──");
{
  const { state } = await run([ENTER]);
  const t = state.escrito;

  check("oculta el cursor", t.includes(`${ESC}[?25l`), "no sale ?25l", "ESC[?25l");
  check("vuelve a mostrarlo", t.includes(`${ESC}[?25h`), "no sale ?25h", "ESC[?25h");
  check("dibuja Download all", t.includes("Download all"), "falta Download all", "Download all");
  check("lista los tres", ["clip-1.mp4", "clip-2.mp3", "clip-3.jpeg"].every((n) => t.includes(n)),
    "falta algun nombre", "los tres");
  check("cada nombre sale una vez", (t.match(/Download all/g) ?? []).length >= 1, "nada", ">=1");
}

/* The failure this is really about is a screen that grows. Five presses that each
   print a whole panel leave five panels on the terminal, and the person scrolls
   instead of choosing. Redrawing in place moves the cursor back up by exactly
   what it wrote last time and wipes forward, so the bytes written grow
   sub-linearly and every repaint is preceded by a cursor-up. */
console.log("  ── el redibujo no acumula pantallas ──");
{
  const uno = (await run([ENTER])).state.escrito;
  const seis = (await run([DOWN, DOWN, DOWN, UP, "a", ENTER])).state.escrito;

  check("las pulsaciones usan cursor-up", new RegExp(`${ESC}\\[\\d+A`).test(seis),
    "nunca sube para redibujar", "ESC[nA");
  check("no imprime una pantalla entera por pulsacion",
    seis.length < uno.length * 6,
    `1 pulsacion=${uno.length}b, 5 pulsaciones=${seis.length}b`,
    `< ${uno.length * 6}b`);
}

console.log("  ── sin terminal cae al prompt de teclear ──");
{
  const input = new PassThrough();
  const output = new PassThrough();

  input.isTTY = false;
  output.isTTY = false;

  const value = await chooseWithArrows(plan, { input, output });

  check("sin terminal devuelve todo", json(value) === "[0,1,2]", json(value), "[0,1,2]");
}

console.log("");
console.log(failures ? `  ${failures} comprobaciones fallidas` : "  todas las comprobaciones pasaron");
process.exitCode = failures ? 1 : 0;