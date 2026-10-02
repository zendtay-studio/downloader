/**
 * Checks `install.sh`: that it can be run, and that it does not carry its own copy
 * of what `package.json` already says.
 *
 * It exists for two failures that are both silent.
 *
 * The first is the executable bit. `npm run i` runs `./install.sh`, so a checkout
 * that lost the bit fails with `Permission denied` — and the bit is not something
 * anyone looks at, because everything else in the repository works fine without it.
 * Git is asked too, and not just the file on disk: the mode recorded in the tree is
 * what a fresh `git clone` hands to somebody else, so a file that is executable here
 * and stored as `100644` is broken for everyone but me.
 *
 * The second is worse. `install.sh` has to know the command's name and the Node
 * version, and the obvious way to write it is to write them down. Then the package
 * is renamed and the script installs and reports a command that does not exist.
 *
 * So the check does not grep for a hardcoded name — grepping cannot tell a name in a
 * comment from a name in a path, and a file with no `ddd` in it can still install
 * `ddd`. It lifts the three lines that read those values out of `package.json` and
 * runs them against a package whose `bin` is called something else. If the answer
 * still comes back `ddd`, the script is carrying its own copy.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = new URL("..", import.meta.url);
const ruta = fileURLToPath(new URL("install.sh", raiz));
const paquete = JSON.parse(readFileSync(new URL("package.json", raiz), "utf8"));

const fallos = [];

function check(etiqueta, condicion, detalle) {
  console.log(`   ${condicion ? "ok  " : "FALLA"}  ${etiqueta}`);

  if (!condicion) fallos.push(detalle ?? etiqueta);
}

// ── the file, and whether it can be run ───────────────────────────────────────

const existe = statSync(ruta, { throwIfNoEntry: false });

check("install.sh existe", Boolean(existe), "install.sh is not in the repository");

if (existe) {
  check("install.sh tiene permiso de ejecucion", (existe.mode & 0o111) !== 0, `install.sh is mode ${(existe.mode & 0o777).toString(8)}`);

  const fuente = readFileSync(ruta, "utf8");

  // The repository is English. A comment in another language is still a comment
  // nobody on the project can read, and this file is the first thing a new person
  // reads after cloning.
  check("install.sh esta en ingles", !/[一-鿿]/.test(fuente), "install.sh contains Chinese characters");

  check("empieza con el shebang de bash", fuente.startsWith("#!/usr/bin/env bash"), "install.sh has no bash shebang");

  check("falla rapido si algo va mal", /set -euo pipefail/.test(fuente), "install.sh does not use `set -euo pipefail`");

  check("solo toca su propio paquete", !fuente.includes("rm -rf"), "install.sh removes something recursively");

  /* Git's copy of the mode. The file on disk can be made executable locally with a
     single `chmod` and committed without it, which passes every check above and
     fails on every machine that clones. */
  let modoGit = "";

  try {
    modoGit = execFileSync("git", ["ls-files", "-s", "--", "install.sh"], { cwd: raiz, encoding: "utf8" }).trim().split(/\s+/)[0];
  } catch {
    modoGit = "sin git";
  }

  check("git lo guarda como ejecutable", modoGit === "100755", `git records install.sh as ${modoGit}, so a clone gets a file it cannot run`);

  // ── the values come from package.json ───────────────────────────────────────

  /* The lines that read them, lifted out of the script rather than restated here:
     a check with its own copy of the extraction would pass while the script
     changed. Nothing is installed — the three assignments are all that run.

     They run under `bash`, not `node`, because they are bash: `leer() { … }` and
     `$(…)` are not JavaScript and `node -e` answers with a syntax error on the
     first line. The point of running them is that `require('./package.json')`
     resolves against the working directory, so this has to be a shell in the
     temporary directory for the file to be read from there. */
  const leer = fuente.match(/^leer\(\) \{.*\}$/m)?.[0];
  const nombre = fuente.match(/^NOMBRE=.*$/m)?.[0];
  const version = fuente.match(/^NODE_PEDIDO=.*$/m)?.[0];

  if (!leer || !nombre || !version) {
    check("install.sh lee el nombre y la version de package.json", false, "the lines that read them out of package.json have moved or are gone");
  } else {
    const dir = mkdtempSync(join(tmpdir(), "downloader-install-"));

    try {
      /* Same package, different command and a different required Node. If the script
         answers with either of these, it read them. */
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "otro", version: "9.9.9", engines: { node: ">=77" }, bin: { zzz: "bin/zzz.mjs" } }),
        "utf8",
      );

      const guion = `${leer}\n${nombre}\n${version}\nprintf '%s|%s' "$NOMBRE" "$NODE_PEDIDO"`;
      const leido = execFileSync("bash", ["-c", guion], { cwd: dir, encoding: "utf8" }).trim();
      const [nombreLeido, versionLeida] = leido.split("|");

      check("el nombre del comando sale de package.json", nombreLeido === "zzz", `install.sh answered "${nombreLeido}" for a package whose command is zzz`);
      check("la version de node sale de package.json", versionLeida === "77", `install.sh answered "${versionLeida}" for a package that needs node 77`);
    } catch (error) {
      check("install.sh lee el nombre y la version de package.json", false, `running those lines failed: ${error.message.split("\n")[0]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── package.json points at it ─────────────────────────────────────────────────

check("npm run i ejecuta install.sh", paquete.scripts?.i === "./install.sh", `scripts.i is ${JSON.stringify(paquete.scripts?.i)}`);

check("install.sh viaja en el paquete", (paquete.files ?? []).includes("install.sh"), "install.sh is not in package.json files, so npm pack drops it");

if (fallos.length > 0) {
  console.error(`\n   ${fallos.length} problem(s) with install.sh.`);
  process.exitCode = 1;
}