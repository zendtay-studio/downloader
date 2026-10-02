/**
 * Generates `og.png`: the image a link preview shows.
 *
 *   node tools/og.mjs           write og.png
 *   node tools/og.mjs --check   fail if og.png is not what this would write
 *
 * It exists as a tool rather than as an image somebody exported once because the
 * image is a lie the moment a platform is added: it said "16 platforms" and listed
 * sixteen while the page said twenty-one and the metatags said twenty-one. Nothing
 * could catch that, because the image is a binary and the page is text. So the
 * names are read out of `index.html` here, and `--check` regenerates and compares
 * bytes, which makes a stale preview a failing `npm run check` instead of a wrong
 * card in somebody's timeline.
 *
 * The rendering goes through ImageMagick's `convert`, which is on the machine and
 * is deterministic here — two runs of the same SVG produce the same bytes, which is
 * what makes the comparison in `--check` possible at all. The alternative, keeping
 * a throwaway script around in `/tmp`, is what let this go stale in the first place.
 *
 * The layout is the one the previous image had, measured off that file rather than
 * guessed: left margin 80, a divider at y=374 in the theme's own line colour, and
 * the same five inks sampled from its pixels.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const PAGE_PATH = new URL("index.html", ROOT);
const TARGET = new URL("images/og.png", ROOT);

/* Sampled from the previous og.png, so the new one is the same card and not a new
   design. The three first are the dark theme's own tokens: `--text-1` is #f2ede4
   and `--text-2` is #c1b8a7, and `--line` is #2e2a25, which is what the divider
   turned out to be. */
const INK = {
  background: ["#161310", "#282420"],
  title: "#F0EBE2",
  subtitle: "#C1B8A7",
  names: "#A8A091",
  footer: "#C7C2B9",
  divider: "#2E2A25",
};

/**
 * The order the names appear in.
 *
 * Deliberately NOT the order of `PLATFORMS`: that is the order of the dispatch
 * table, which is about which extractor claims a link first, and it puts Snapchat
 * and Dailymotion near the top. A preview card is read by someone deciding whether
 * to click, so this is ordered by how likely the reader is to care, and the biggest
 * names come first.
 *
 * What is NOT a choice is the content: the list has to cover exactly the platforms
 * the page knows about. That is checked below, so adding a platform without adding
 * it here is an error and not a silent omission.
 */
const KIND_ORDER = [
  "tiktok", "instagram", "threads", "youtube", "pinterest", "pornhub",
  "facebook", "x", "ok", "bluesky", "dailymotion", "snapchat",
  "kwai", "spotify", "reddit", "soundcloud", "bilibili", "loom",
  "vimeo", "streamable", "rutube",
];

/** The lines the list is wrapped into. Six per line reads as a block, not as a column. */
const PER_LINE = 6;

// ── the names, read from the page so they cannot go stale ──────────────────

const html = readFileSync(PAGE_PATH, "utf8");

function block(name) {
  const start = html.indexOf(`const ${name} = {`);

  if (start < 0) throw new Error(`index.html has no ${name}`);

  return html.slice(start, html.indexOf("\n};", start));
}

/** `platform: "Name"` out of `BRAND`. */
const BRAND = new Map(
  [...block("BRAND").matchAll(/^\s*([a-z]+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
);

const PLATFORMS = [...html.matchAll(/^\s*\{ id: "([a-z]+)"/gm)].map((m) => m[1]);

const missing = PLATFORMS.filter((id) => !KIND_ORDER.includes(id));
const extra = KIND_ORDER.filter((id) => !PLATFORMS.includes(id));

if (missing.length || extra.length) {
  const messages = [];

  if (missing.length) messages.push(`missing from ORDEN: ${missing.join(", ")}`);
  if (extra.length) messages.push(`in ORDEN but not a platform: ${extra.join(", ")}`);

  throw new Error(
    `tools/og.mjs is out of date — ${messages.join("; ")}. `
    + "Fix the list and run `node tools/og.mjs`.",
  );
}

const nameless = KIND_ORDER.filter((id) => !BRAND.get(id));

if (nameless.length) {
  throw new Error(`BRAND has no name for: ${nameless.join(", ")}`);
}

const names = KIND_ORDER.map((id) => BRAND.get(id));
const lines = [];

for (let i = 0; i < names.length; i += PER_LINE) {
  lines.push(names.slice(i, i + PER_LINE).join(" - "));
}

// ── the card ────────────────────────────────────────────────────────────────

const WIDTH = 1200;
const HEIGHT = 630;
const MARGIN = 80;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Every coordinate is absolute on purpose. ImageMagick's built-in SVG renderer is
   thin on transforms, and a path written out at 1200x630 is also readable: the
   arrow below is the page's brand mark, whose own path is `M12 4v10` in a 24-unit
   box, multiplied by ten and moved to (780, 142). */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="fondo" x1="0" y1="0" x2="1" y2="0.35">
      <stop offset="0" stop-color="${INK.background[0]}"/>
      <stop offset="1" stop-color="${INK.background[1]}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#fondo)"/>

  <text x="${MARGIN}" y="221" font-family="Helvetica, Arial, sans-serif" font-size="94" font-weight="700" fill="${INK.title}">Downloader</text>

  <text x="${MARGIN}" y="281" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="${INK.subtitle}">Download video, audio and photos</text>
  <text x="${MARGIN}" y="331" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="${INK.subtitle}">from ${PLATFORMS.length} platforms.</text>

  <g fill="none" stroke="${INK.title}" stroke-width="24" stroke-linecap="round" stroke-linejoin="round">
    <path d="M900 182V280"/>
    <path d="M855 242L900 287L945 242"/>
    <path d="M830 332H970"/>
  </g>

  <rect x="${MARGIN}" y="374" width="${WIDTH - MARGIN * 2}" height="4" fill="${INK.divider}"/>

  ${lines.map((line, i) => `  <text x="${MARGIN}" y="${424 + i * 34}" font-family="Helvetica, Arial, sans-serif" font-size="27" fill="${INK.names}">${esc(line)}</text>`).join("\n  ")}

  <text x="${MARGIN}" y="594" font-family="Helvetica, Arial, sans-serif" font-size="31" font-weight="700" fill="${INK.footer}">Paste a link. Pick what you want. Nothing to install.</text>
</svg>
`;

// ── rasterise ───────────────────────────────────────────────────────────────

/* `-strip` so nothing version-specific or time-shaped lands in the file: the check
   below is a byte comparison, and a `tIME` chunk would break it on its own. */
function rasterize(destPath) {
  execFileSync(
    "convert",
    ["svg:-", "-background", "none", "-density", "96", "-depth", "8", "-strip", destPath],
    { input: svg, stdio: ["pipe", "pipe", "pipe"] },
  );
}

const check = process.argv.includes("--check");

if (check) {
  const dir = mkdtempSync(join(tmpdir(), "downloader-og-"));
  const tempFile = join(dir, "og.png");

  try {
    rasterize(tempFile);

    const actual = readFileSync(TARGET);
    const expected = readFileSync(tempFile);

    if (actual.equals(expected)) {
      console.log(`   og.png up to date: ${PLATFORMS.length} platforms, ${actual.length} bytes`);
    } else {
      /* The two causes need different answers and only one of them is a stale
         list. Same byte count but different bytes means the file was edited by
         hand or re-encoded; a different size usually means the text moved. Saying
         "the platforms do not match" for a re-encoded PNG would send whoever
         reads it to the wrong place. */
      const rewritten = actual.length === expected.length;

      console.error(
        `   og.png is NOT up to date: ${rewritten
          ? "same byte count, different content (hand-edited or re-encoded)"
          : `the size changes: ${actual.length} bytes now, ${expected.length} when generated`}`,
      );
      console.error(`   This generator would put ${PLATFORMS.length} platforms.`);
      console.error("   Regenerate with:  node tools/og.mjs");
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  rasterize(fileURLToPath(TARGET));

  const bytes = readFileSync(TARGET).length;

  console.log(`   og.png: ${WIDTH}x${HEIGHT}, ${PLATFORMS.length} platforms in ${lines.length} lines, ${bytes} bytes`);
}