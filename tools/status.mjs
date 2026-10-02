/**
 * Every message-carrying `throw` in `src/` has to answer with something other
 * than a 500, unless the message describes a fault on this side.
 *
 * It exists because the rule was already written down — in `api.mjs`, next to the
 * `BAD_REQUEST` it implements — and was not met. Of 59 plain throws, 58 came out
 * as 500. Almost all of them were about the link the caller pasted: a deleted
 * video, a private account, a link that points at a playlist. A 500 for those
 * says two wrong things at once: it tells the caller to retry something that will
 * never work, and it puts dead links into the Worker's error rate next to real
 * outages, where nobody can tell them apart.
 *
 * So the fix was to wrap them in `explain()` or to carry the real status. This
 * is the half that keeps them from growing back: the rule was applied once by
 * hand and there is nothing stopping the next `throw new Error` from being a 500
 * again.
 *
 * A plain `throw new Error` is a *server* fault by default. That is the safe
 * direction to be wrong in: it never turns a real outage into a 404.
 */
import { readFileSync, readdirSync } from "node:fs";

import { statusFor } from "../src/api.mjs";

/* Discovered, not listed: a platform file that nobody added here would skip the
   check without anything saying so, which is the failure this file exists to
   prevent. Sorted so two runs read the same order. */
const PLATFORMS = readdirSync(new URL("../src/platforms/", import.meta.url))
  .filter((n) => n.endsWith(".js"))
  .sort()
  .map((n) => `src/platforms/${n}`);

const SOURCES = [
  "src/core.mjs",
  ...PLATFORMS,
  "src/dispatch.mjs",
  "src/universal.mjs",
  "src/api.mjs",
  "src/worker-entry.js",
];

/**
 * Messages that are genuinely this side's fault, where 500 is the right answer.
 *
 * Kept as a list and not as a pattern, because the whole point is to be wrong
 * here loudly: a new one has to be added with a reason rather than slipping in
 * because a sentence happened to contain "could not".
 */
const SERVER_FAILURES = [
  "The YouTube configuration could not be fetched",
  "The public key could not be read from the page",
  "The media server responded",
  "The media file could not be downloaded",
  "The video responded",
  "The file responded",
  "The playlist is nested too deeply",
  // The repository not answering is this side's problem, not the caller's: there
  // is no bad link that produces these three.
  "GitHub responded",
  "GitHub returned no HTML",
];

/** Extracts the message of a `throw new Error(...)`, following nested parens. */
function messageFrom(src, from) {
  let depth = 0;
  let text = "";
  let i = src.indexOf("(", from);

  for (; i < src.length; i++) {
    const char = src[i];

    if (char === "(") {
      depth++;

      if (depth === 1) continue;
    }

    if (char === ")") {
      depth--;

      if (depth === 0) break;
    }

    text += char;
  }

  return text
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\s*\+\s*$/, "")
    .replace(/\s*\+/g, " ")
    .replace(/\$\{[^}]*\}/g, "N")
    .trim();
}

const suspects = [];
let total = 0;

for (const file of SOURCES) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

  for (const match of src.matchAll(/\bthrow\s+new Error\(/g)) {
    total++;

    const message = messageFrom(src, match.index);

    if (statusFor(new Error(message)) !== 500) continue;
    if (SERVER_FAILURES.some((reason) => message.includes(reason))) continue;

    suspects.push({
      file,
      lineNo: src.slice(0, match.index).split("\n").length,
      message,
    });
  }
}

if (suspects.length) {
  console.log(`\n${suspects.length} of ${total} plain throws come out as 500 and are not server faults:\n`);

  for (const s of suspects) {
    console.log(`  ${s.file}:${s.lineNo}  ${s.message.slice(0, 78)}`);
  }

  console.log("\n  Wrap them in explain() if it is the link's fault, or pass the status with");
  console.log("  conEstado(new Error(...), status) if the platform has already said so.\n");
  process.exitCode = 1;
} else {
  console.log(`${total} throws with a message, none of them a 500 without a reason`);
}
