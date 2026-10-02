#!/usr/bin/env node
/**
 * Downloads from the terminal: `ddd <link>`.
 *
 * Lives apart from `src/` because it is the only part that needs a filesystem.
 * Everything under `src/` stays free of `node:*` so it can also load in a
 * Cloudflare Worker, where `node:fs` does not exist and would take the whole
 * module down at boot.
 */
import { createWriteStream, realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { hlsPartResponse, hlsParts } from "../src/api.mjs";
import {
  MOBILE_USER_AGENT,
  fetchTimed,
  mediaExtension,
  mediaName,
  openMediaResponse,
  resetSubrequests,
} from "../src/core.mjs";
import { resolveMedia } from "../src/dispatch.mjs";
import { choose, chooseWithArrows, chooseWithoutAsking, withProgress, interactive } from "./select.mjs";

const HELP = `ddd <link> [options]

  Downloads a video, audio track or photo. Paste a link; the files it points at
  are listed and, when there is a terminal to answer, you choose which to take.

Quote a link that holds & or any other shell character. The shell does not know
what a link is, so an unquoted one is cut in half: everything before the & runs
as a background job and the rest is read as a command. Both halves then do
something other than what you asked for, and neither says so.

  ddd "https://www.tiktok.com/@someone/video/123?is_from_webapp=1&device=pc"

The truncated half is usually still a working link, so the wrong download is
what you notice rather than the missing one.

Options
  --all            take everything, without asking
  --only <kind>    take only these kinds: video, audio, image
                   (comma separated, e.g. --only audio,video)
  --index <list>   take these numbers, e.g. --index 1,3
  --ask            ask even when the output is not a terminal
  --no-progress    do not draw the progress bar
  --diagnose       why the terminal is not being seen, and stop
  -h, --help       this text

Without a terminal, and without options, it takes everything. That is deliberate:
a run with nobody watching it should do what it says instead of waiting.
`;

/** The flags, kept apart from the link so a link with a dash in it is still a link. */
function parseArgs(argv) {
  const options = { link: null, all: false, only: null, index: null, progress: true, help: false, ask: false, diagnose: false };
  const loose = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--all" || arg === "-a") options.all = true;
    else if (arg === "--no-progress") options.progress = false;
    else if (arg === "--ask") options.ask = true;
    else if (arg === "--diagnose") options.diagnose = true;
    else if (arg === "--only" || arg === "-o") options.only = argv[++i] ?? null;
    else if (arg === "--index" || arg === "-i") options.index = argv[++i] ?? null;
    else if (arg.startsWith("-") && arg !== "-") throw new Error(`unknown option: ${arg}  (try --help)`);
    else loose.push(arg);
  }

  options.link = loose[0] ?? null;

  /* More than one link is not an error: they go one after the other. It is what
     someone pasting a list expects, and refusing it would be pedantic. */
  options.links = loose;

  return options;
}

export async function download(input, options = {}) {
  if (!input) {
    throw new Error("Usage: ddd <link>  (or: node bin/cli.mjs <link>)");
  }

  /* The subrequest budget is per request and the Worker resets it in `dispatch`.
     The CLI has no dispatcher, so it resets it here: without this, the second
     link in the same run would start where the first one finished, and a
     playlist or a highlight would run out mid-way for no reason. */
  resetSubrequests();

  const { files, prefix, referer } = await resolveMedia(input);
  const headers = {
    "User-Agent": MOBILE_USER_AGENT,
    Referer: referer,
  };

  /* What each file will be called, decided before anything is asked or
     downloaded, so the list on screen is the list that lands on disk. */
  const plan = files.map((file, index) => {
    const hls = Boolean(file.hls && /\.m3u8/i.test(file.media?.[0] ?? ""));
    const extension = mediaExtension(file, file.media?.[0] ?? "", "");
    const filename = hls ? null : mediaName(prefix, extension, index, files.length, file.label);

    return { file, index, hls, kind: file.kind ?? "file", extension, name: filename ?? `(${file.kind} stream)` };
  });

  /* Order: video, then audio, then image, whatever order the extractor answered
     in.

     Not cosmetic. TikTok has two paths and which one delivers decides the order it
     returns: ours gives `video, cover`, ssstik's gives `video, audio, cover`, and
     the m4a copy of the video is appended at the end. So across three runs of the
     same link, file 2 was the mp3 once and the photo twice — which makes
     `--index 2` a different download each time, and the number in the list a
     different file on every run. Picking by number needs the number to mean
     something.

     It is the same order `universal.mjs` walks its own list in. */
  const KIND_ORDER = ["video", "audio", "image"];

  plan.sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);

    return byKind !== 0 ? byKind : a.index - b.index;
  });

  /* Renumbered after the sort, so the `-2` in a name is the 2 on the list. Left
     on the original position it would name the first file `-3`, which is a fine
     name and a terrible answer to "which one was 2?". */
  for (const [position, item] of plan.entries()) {
    item.index = position;
    item.name = item.hls
      ? item.name
      : mediaName(prefix, item.extension, position, plan.length, item.file.label);
  }

  /* Printed for every path that does not draw its own screen. The arrow selector
     draws its own, so printing it here as well showed it twice. It is printed at
     all on the paths that take everything without asking —piped, aliased,
     detached— because downloading three files when you wanted one is worth a
     line of output even with nobody there to answer a question about it. */
  const printList = () => {
    if (plan.length < 2) return;

    console.log("");

    for (const [i, f] of plan.entries()) {
      console.log(`   ${i + 1}) ${(f.hls ? "stream" : f.kind).padEnd(6)} ${f.name}`);
    }
  };

  let picked;

  if (options.all || options.only || options.index != null) {
    printList();
    picked = chooseWithoutAsking(plan, { only: options.only, index: options.index });
  } else if (interactive(process.stdin) && interactive(process.stdout)) {
    /* A terminal gets the arrows. Everything is ticked already, because "take it
       all" is what this run would have done unasked, so the only question is
       which of them to leave out. */
    picked = await chooseWithArrows(plan);
  } else if (options.ask) {
    /* `--ask` through a pipe: no arrows to press, so the same answers in words. */
    printList();
    picked = await choose(plan, { forzar: true });
  } else {
    printList();
    picked = plan.map((_, i) => i);
  }

  if (picked === null) {
    console.log("Nothing taken.");
    return [];
  }

  const saved = [];

  for (const i of picked) {
    const { file, index, hls, name, extension } = plan[i];

    /* HLS goes its own way. `openMediaResponse` refuses it on purpose, because
       a `.m3u8` is a playlist and not a file, so without this branch every
       Reddit video, every X video and everything the universal extractor finds in
       a playlist was undownloadable here while the API served it fine. The
       playlist is read once and the parts are written in order. */
    if (hls) {
      const playlist = await hlsParts(file.media[0], file.kind === "audio" ? "audio" : "video", {
        prefix,
        index,
        total: files.length,
        label: file.label,
      });

      /* The parts are known before the first one is fetched, so the total is
         known too, and the bar is real rather than a guess. */
      await pipeline(
        Readable.from(
          (async function* () {
            if (playlist.single) {
              const part = playlist.single;
              const range = await fetchTimed(part.url, {
                headers: { ...headers, Range: `bytes=${part.start}-${part.end}` },
              });

              if (!range.ok) {
                throw new Error(`The video responded ${range.status}`);
              }

              yield* Readable.fromWeb(range.body);

              return;
            }

            for (const part of playlist.parts) {
              const response = await hlsPartResponse(part);

              yield* Readable.fromWeb(response.body);
            }
          })(),
        ),
        options.progress
          ? withProgress({ label: playlist.name }).pipe(createWriteStream(playlist.name))
          : createWriteStream(playlist.name),
      );

      console.log(`Downloaded: ${playlist.name}`);
      saved.push(playlist.name);
      continue;
    }

    const response = await openMediaResponse(file, headers);
    const contentType = response.headers.get("content-type") ?? "";
    const total = Number(response.headers.get("content-length") ?? 0);

    /* The name is decided HERE, with the real content type, and not before the
       download. The list on screen has to be built before anything is chosen, and
       at that point the only evidence is the URL — and for a photo with no
       extension in its address that is not enough: `image/jpeg` is the difference
       between `.jpeg` and `.jpg`, and reading it from the response is the only way
       to tell. So the list is a best guess and this line is the truth. */
    const filename = mediaExtension(file, response.url || file.media?.[0], contentType) === extension
      ? name
      : mediaName(prefix, mediaExtension(file, response.url || file.media?.[0], contentType), index, files.length, file.label);

    await pipeline(
      Readable.fromWeb(response.body),
      options.progress
        ? withProgress({ total, label: filename }).pipe(createWriteStream(filename))
        : createWriteStream(filename),
    );

    console.log(`Downloaded: ${filename}`);
    saved.push(filename);
  }

  return saved;
}

/**
 * Was this file called directly?
 *
 * The comparison has to be against the REAL path. Installed with `npm link` or
 * `npm i -g`, what runs is a symlink —`ddd` pointing at `bin/cli.mjs`—:
 * `process.argv[1]` holds the symlink path and `import.meta.url` the real file,
 * so they never match and the program does nothing, silently, with exit code 0.
 *
 * That silence is the failure, and it was the failure this is here to prevent:
 * nothing runs, nothing is printed, and the exit code says the run was fine. So
 * when the answer is no, it says so and why. A wrong answer here costs a person
 * an afternoon of wondering whether the link was bad.
 */
function isMainProgram() {
  if (!process.argv[1]) return { ok: false, why: "there is no argv[1] to compare against" };

  try {
    const real = realpathSync(process.argv[1]);

    if (import.meta.url !== pathToFileURL(real).href) {
      return {
        ok: false,
        why: `import.meta.url is ${import.meta.url}\n`
          + `                 but argv[1] resolves to ${pathToFileURL(real).href}`,
      };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, why: `argv[1] could not be resolved: ${error.message}` };
  }
}

const main = isMainProgram();

if (main.ok) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));

    if (options.diagnose) {
      console.log("Terminals");
      console.log(`   stdin  isTTY=${Boolean(process.stdin.isTTY)}`);
      console.log(`   stdout isTTY=${Boolean(process.stdout.isTTY)}   columns=${process.stdout.columns ?? "?"}`);
      console.log(`   stderr isTTY=${Boolean(process.stderr.isTTY)}`);
      console.log("");
      console.log("  isTTY false on stdout means the list is printed but nothing is asked,");
      console.log("  and the progress bar is skipped. `ddd <link> | cat` does that on purpose.");
      console.log("  A shell that runs ddd in the background does it by accident, and the");
      console.log("  output goes wherever the job's stdout was pointed.");
      return;
    }

    if (options.help) {
      process.stdout.write(HELP);
      return;
    }

    if (!options.links.length) {
      process.stderr.write(HELP);
      process.exitCode = 1;
      return;
    }

    const savedFiles = [];

    for (const link of options.links) {
      savedFiles.push(...(await download(link, options)));
    }

    /* A run that took more than one thing, or that took nothing, gets a total
       the eye can land on. One file does not need one. */
    if (savedFiles.length !== 1) console.log(`\n${savedFiles.length} files.`);
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else if (process.argv[1] && !process.env.DDD_IMPORTADO) {
  /* Imported rather than run — that is the exported `download()`, and it is
     silent on purpose. Only complain when this looks like somebody ran the file
     and got nothing back. */
  console.error(
    `ddd did nothing: this file does not think it is the program being run.\n`
    + `  ${main.why}\n`
    + "This is the bug the check below exists for; run it with --diagnose.",
  );
  process.exitCode = 1;
}
