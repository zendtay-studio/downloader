/**
 * Checks that the stylesheet inside `index.html` is balanced.
 *
 * An unclosed brace raises no error: the browser silently swallows everything
 * after it, which looks like "the animations do not work" for no apparent
 * reason. An unclosed comment does the same and is the easiest way to do it.
 *
 * Only braces are counted, since those are what break. Whether each rule is
 * valid is decided by the browser at paint time and cannot be checked from here.
 */
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const start = page.indexOf("<style>");
const end = page.indexOf("</style>");

/* `end < start` is the case that used to pass. A `</style>` above the `<style>`
   makes the slice empty, and an empty stylesheet has no braces and no comments,
   which is perfectly balanced: the tool printed "0 rules, braces and comments
   balance" and the page had no styles at all. */
if (start < 0 || end < 0 || end < start) {
  console.error("   index.html has no inline stylesheet");
  process.exit(1);
}

const sheet = page.slice(start + "<style>".length, end);
const open = (sheet.match(/\{/g) ?? []).length;
const close = (sheet.match(/\}/g) ?? []).length;
const commentOpen = (sheet.match(/\/\*/g) ?? []).length;
const commentClose = (sheet.match(/\*\//g) ?? []).length;

let bad = 0;

if (open !== close) {
  console.error(`   braces: ${open} open and ${close} close`);
  bad = 1;
}

if (commentOpen !== commentClose) {
  console.error(`   comments: ${commentOpen} open and ${commentClose} close`);
  bad = 1;
}

if (!bad) console.log(`   ${open} rules, braces and comments balance`);

process.exit(bad);
