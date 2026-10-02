/**
 * The interactive part of the CLI: choosing which of the files to take, and
 * showing how far each one has got.
 *
 * Split from `cli.mjs` because that file is the deployment path and this is not:
 * nothing here runs in the Worker, and keeping it apart means the Worker build
 * has no reason to care that any of it exists.
 *
 * Two rules run through all of it.
 *
 * **Nothing is interactive unless there is a person there.** Both the prompt and
 * the progress bar check whether stdout/stderr is a terminal. Piped into a file,
 * into `grep`, or run from a script, the output is the same plain lines it has
 * always been, because a prompt with nobody to answer it is a hang. That is also
 * why the default with no answer is "everything": a run that is not being watched
 * should do what it says.
 *
 * **The progress bar goes to stderr, the results to stdout.** A progress bar is a
 * display, not data. Putting it on stdout would corrupt `ddd <link> > files.txt`
 * and every pipeline built on it.
 */
import { Transform } from "node:stream";

/** Is this stream a terminal a person is looking at? */
export function interactive(stream = process.stdout) {
  return Boolean(stream?.isTTY);
}

/** `1.2 MB`, `940 B`, `0 B` — the same rounding the API uses. */
export function size(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1000) return `${bytes} B`;

  const units = ["kB", "MB", "GB", "TB"];
  let selection = bytes;
  let i = -1;

  /* Divide first, then look at what is left. The other way round — divide once,
     then loop while the result is still three digits — was off by one in both
     directions: 1.5 kB came out as "1.5 undefined" because the index started at
     -1, and 24 MB came out as "24 kB" because the loop stopped a step early. */
  do {
    selection /= 1000;
    i += 1;
  } while (selection >= 1000 && i < units.length - 1);

  return `${selection < 10 ? selection.toFixed(1) : Math.round(selection)} ${units[i]}`;
}

const BARRA = 24;

/**
 * Counts bytes on their way through, and draws a bar while they do.
 *
 * A `Transform` rather than a wrapper around the write stream, so the pipeline
 * still does the writing and the only thing added is a look at each chunk.
 *
 * With no `content-length` there is nothing to be a percentage *of*, and a bar
 * that guesses is worse than none: it would sit at 3% forever on a stream that
 * is working fine. In that case it counts bytes and speed without a bar, which is
 * still the thing you want to know while a large file arrives.
 */
export function withProgress({ total = 0, label = "", stream = process.stderr } = {}) {
  let received = 0;
  let lastDraw = 0;
  let enabled = Boolean(total) && interactive(stream);

  const draw = (forced = false) => {
    if (!enabled || !interactive(stream)) return;

    const ahora = Date.now();

    if (!forced && ahora - lastDraw < 100) return;

    lastDraw = ahora;

    const width = Math.max(10, (stream.columns ?? 80) - label.length - 34);
    const ratio = total ? Math.min(1, received / total) : 0;
    const filled = Math.round(ratio * width);
    const seconds = (ahora - start) / 1000;
    const speed = seconds > 0.2 ? received / seconds : 0;
    const bar = "█".repeat(filled) + "░".repeat(width - filled);

    stream.write(
      `\r  ${label}  ${bar}  ${(ratio * 100).toFixed(0).padStart(3)}%  `
      + `${size(received).padStart(9)}${total ? ` / ${size(total)}` : ""}  `
      + `${speed > 0 ? size(speed) + "/s" : ""}`.padEnd(12),
    );
  };

  const start = Date.now();

  return new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      draw();
      done(null, chunk);
    },
    flush(done) {
      if (enabled && interactive(stream)) {
        draw(true);
        stream.write("\n");
      }

      done();
    },
  });
}

/* ── the arrow-key selector ────────────────────────────────────────────────── */

const ESC = "\x1b";

/**
 * Arrow keys, space to tick, enter to go.
 *
 * This reads the keyboard raw, which is the only way to see an arrow without the
 * user having to press Enter first. Raw mode turns off the terminal's own line
 * editing and the echo, so it has to be put back — every path out of here goes
 * through `restore`, quit and Ctrl-C included, because a terminal left with no
 * echo looks like a broken shell and the only way out is a new window.
 *
 * Everything starts ticked, because "take it all" is what this run would have
 * done without asking anybody, and the only thing being asked is which of them to
 * leave out.
 *
 * Falls back to `choose` when there is no terminal, so a piped run never waits for
 * a keypress that cannot arrive.
 */
export async function chooseWithArrows(files, { input = process.stdin, output = process.stdout } = {}) {
  if (!interactive(input) || !interactive(output)) {
    return choose(files, { input, output });
  }

  const { createInterface, emitKeypressEvents } = await import("node:readline");

  emitKeypressEvents(input);

  const rl = createInterface({ input: input, terminal: false });
  const total = files.length;
  const ticked = new Set(files.map((_, i) => i));

  /* Row 0 is "everything", so the cursor starts on the answer the run would have
     taken on its own and the first keypress says whether that is still right. */
  let cursor = 0;
  let printed = 0;

  const width = output.columns ?? 80;
  const divider = `  ${"─".repeat(Math.max(10, Math.min(width - 2, 62)))}`;

  const lines = () => {
    const todo = ticked.size === total;
    const out = [];

    out.push(`  ${todo ? "x" : " "}  Download all  (${total} files)`);
    out.push(divider);

    for (const [i, f] of files.entries()) {
      const isCurrent = i + 1 === cursor;
      const mark = ticked.has(i) ? "✓" : "·";

      out.push(` ${isCurrent ? "›" : " "} ${String(i + 1)}) ${mark} ${(f.hls ? "stream" : f.kind).padEnd(6)} ${f.name}`);
    }

    out.push(divider);
    out.push(`  ↑ ↓ move   space tick   a all   n none   enter download   q quit`);

    return out;
  };

  const draw = () => {
    /* Move back up by exactly what was written last time, then wipe forward.
       Printing the panel again instead would leave one panel per keypress on the
       screen, and the person scrolls instead of choosing. */
    let out = "";

    if (printed) out += `${ESC}[${printed}A${ESC}[0J`;

    const ls = lines();

    out += `${ls.join("\n")}\n`;
    output.write(out);
    printed = ls.length;
  };

  const restore = () => {
    try {
      if (input.isTTY) input.setRawMode?.(false);
    } catch {}

    input.pause?.();
    rl.close();
    output.write(`${ESC}[?25h`);
  };

  input.setRawMode?.(true);
  output.write(`${ESC}[?25l`);

  const state = { finished: false };

  const finish = (selection) => {
    if (state.finished) return;

    state.finished = true;
    output.write("\n");
    restore();
    state.resolver(selection);
  };

  /* Named, because `off` needs the same listener `on` was given. `off("keypress")`
     with no function throws — and it threw on every path out of here, so the
     selection was made correctly and then the process died unwinding, taking the
     download with it. */
  const onKeypress = (str, key = {}) => {
    if (key.ctrl && key.name === "c") {
      finish(null);
      return;
    }

    /* `readline` maps both encodings of the arrow — ESC[A and ESC OA, the latter
       sent by terminals in application mode — to the same `name`, so matching on
       that covers both. Comparing the raw bytes would work on one terminal and
       not the other. */
    if (key.name === "up" || str === "k") cursor = Math.max(0, cursor - 1);
    else if (key.name === "down" || str === "j") cursor = Math.min(total, cursor + 1);
    else if (str === " " || key.name === "space") {
      if (cursor === 0) {
        if (ticked.size === total) ticked.clear();
        else for (let i = 0; i < total; i += 1) ticked.add(i);
      } else if (ticked.has(cursor - 1)) ticked.delete(cursor - 1);
      else ticked.add(cursor - 1);
    } else if (str === "a" || str === "A") {
      for (let i = 0; i < total; i += 1) ticked.add(i);
    } else if (str === "n" || str === "N") ticked.clear();
    else if (str === "q" || str === "Q" || key.name === "escape") {
      finish(null);
      return;
    } else if (key.name === "return" || str === "\r" || str === "\n") {
      finish([...ticked].sort((a, b) => a - b));
      return;
    }

    draw();
  };

  const promise = new Promise((resolve) => { state.resolver = resolve; });

  input.on("keypress", onKeypress);

  draw();

  const chosen = await promise;

  /* Not in a `finally`: the terminal is already back and the listener already
     gone, so failing to tidy up must not throw away the answer. */
  input.off("keypress", onKeypress);

  return chosen;
}

/**
 * Asks which of the files to take, by typing.
 *
 * The fallback, and what a pipe gets with `--ask`. Same answers in words.
 *
 * The list is not printed here. The caller prints it before deciding whether to
 * ask, so a run that takes everything without asking still shows what the
 * alternatives were — printing it in both places showed it twice.
 */
export async function choose(files, { input = process.stdin, output = process.stdout, forzar = false } = {}) {
  /* `forzar` is `--ask`: ask even when there is no terminal, because a person said
     to. A pipe is a pipe and readline is happy on one, so this works; what it
     cannot do is draw a progress bar, and it does not try. */
  const available = forzar || (interactive(input) && interactive(output));

  if (!available) return files.map((_, i) => i);

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: input, output: output });

  /* Lines are read through an iterator rather than with a `question()` per turn.
     `question()` listens for exactly one line and lets the rest go, so anything
     that arrived early was dropped on the floor: a pasted "9\n1\n" — answer,
     reject, correct answer — hung on the second prompt with the correction
     already consumed. The iterator takes them in order and keeps them, so the
     same input recovers instead of stalling. */
  const lines = rl[Symbol.asyncIterator]();

  try {
    /* The list is not printed here. The caller prints it before it decides
       whether to ask, so that a run which takes everything without asking still
       shows what the alternatives were — and printing it in both places showed it
       twice. */

    for (;;) {
      output.write(
        `\n   all (${files.length})  ·  numbers, e.g. 1 2 3  ·  ranges, e.g. 2-3  ·  q to quit\n   > `,
      );

      const { value, done } = await lines.next();

      if (done) return null;

      const response = String(value ?? "").trim().toLowerCase();

      if (!response || response === "a" || response === "all" || response === "todo") {
        return files.map((_, i) => i);
      }

      if (response === "q" || response === "quit" || response === "salir") return null;

      const picked = new Set();
      let errorText = null;

      for (const token of response.split(/[\s,]+/).filter(Boolean)) {
        const range = /^(\d+)-(\d+)$/.exec(token);

        if (range) {
          const from = Number(range[1]);
          const to = Number(range[2]);

          if (from > to || from < 1 || to > files.length) {
            errorText = `no such range: ${token}`;
            break;
          }

          for (let n = from; n <= to; n += 1) picked.add(n - 1);
          continue;
        }

        const n = Number(token);

        if (!Number.isInteger(n) || n < 1 || n > files.length) {
          errorText = `no such file: ${token}`;
          break;
        }

        picked.add(n - 1);
      }

      if (errorText) {
        output.write(`   ${errorText}\n`);
        continue;
      }

      if (picked.size) return [...picked].sort((a, b) => a - b);
    }
  } finally {
    rl.close();
  }
}

/**
 * The same choice, without asking.
 *
 * `--only` takes a kind and matches every file of it, because "just the audio"
 * is a thing people want and there is no index for it that survives a platform
 * changing how many files it returns.
 */
export function chooseWithoutAsking(files, { only = null, index = null } = {}) {
  /* Contradictory options used to be decided silently: `--only video --index 9`
     returned the video and never mentioned the 9, so a typo looked like it had
     worked. Two ways of choosing the same thing cannot both apply. */
  if (only && index != null) {
    throw new Error("--only and --index are two ways of choosing: use one");
  }

  if (only) {
    const kinds = String(only).toLowerCase().split(",").map((k) => k.trim()).filter(Boolean);
    const picked = files.map((f, i) => (kinds.includes(f.kind) ? i : -1)).filter((i) => i >= 0);

    if (!picked.length) {
      const available = [...new Set(files.map((f) => f.kind))].join(", ");

      throw new Error(`no ${kinds.join(" or ")} in that link — it has ${available}`);
    }

    return picked;
  }

  if (index != null) {
    const picked = String(index).split(",").map((n) => Number(n.trim()) - 1);

    for (const i of picked) {
      if (!Number.isInteger(i) || i < 0 || i >= files.length) {
        throw new Error(`no file ${i + 1}: that link has ${files.length}`);
      }
    }

    return picked;
  }

  return files.map((_, i) => i);
}
