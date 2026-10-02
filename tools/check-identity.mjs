/**
 * Checks that commits are signed by somebody GitHub can attribute.
 *
 * It exists because of a real one. Every commit in this repository was authored as
 * `ZendTay <zendtay@users.noreply.github.com>`, set with `git config --local`, and
 * there is no GitHub account called `ZendTay` — the API answers 404 for it. The
 * account that does exist is `zendtay-studio`. GitHub attributes a commit by the
 * email's domain and the verified address, so a name that matches no account leaves
 * the commits attributed to a stranger, and the work is not shown on the profile
 * that owns it.
 *
 * Nothing reports that. `git log` prints whatever name is in there, the push
 * succeeds, GitHub shows no warning, and the only symptom is that the commits do
 * not appear on the account.
 *
 * A repository-local `user.name` is how the wrong one got there in the first place:
 * it overrides the correct global value for this repository only, so it is the one
 * place that is not obvious to look.
 *
 * The email is checked too, and specifically its domain. `users.noreply.github.com`
 * is the address for an account that has never had to publish an email, and it is
 * what GitHub documents for exactly this. A personal address in the history of a
 * public repository is a second problem, and the fix for the first one is the fix
 * for both.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* Two forms of the same directory and both are needed, which is the trap: `new URL`
   needs a URL and `execFileSync` needs a path. Passing the path to `new URL` fails
   with `Invalid URL`, and passing the URL to `cwd` fails more quietly, by running
   git somewhere else. */
const raizUrl = new URL("..", import.meta.url);
const raiz = fileURLToPath(raizUrl);
const paquete = JSON.parse(readFileSync(new URL("package.json", raizUrl), "utf8"));

const fallos = [];

function check(etiqueta, condicion, detalle) {
  console.log(`   ${condicion ? "ok  " : "FALLA"}  ${etiqueta}`);

  if (!condicion) fallos.push(detalle ?? etiqueta);
}

function git(...args) {
  return execFileSync("git", args, { cwd: raiz, encoding: "utf8" }).trim();
}

/* The account that owns the repository, out of the repository URL. Read rather than
   written down: this file and package.json would otherwise disagree the first time
   the project moved, and the disagreement would be invisible. */
const duenio = /github\.com[/:]([^/]+)\//.exec(paquete.repository?.url ?? "")?.[1];

check("package.json dice de quien es el repo", Boolean(duenio), "could not read the owner out of package.json repository.url");

if (duenio) {
  check("el propietario es una cuenta de GitHub con forma de nombre", /^[a-z0-9-]+$/i.test(duenio), `owner "${duenio}" is not a GitHub login`);

  /* What the commits are actually signed with. `--local` first because that is the
     one that overrode the global value; falling back to it is the case that matters. */
  const nombre = git("config", "--local", "user.name") || git("config", "--global", "user.name") || "";
  const correo = git("config", "--local", "user.email") || git("config", "--global", "user.email") || "";

  check("user.name es el propietario", nombre === duenio, `user.name is "${nombre}" and the repository is "${duenio}"`);
  check("user.email es del propietario", correo.endsWith(`+${duenio}@users.noreply.github.com`) || correo === `${duenio}@users.noreply.github.com`, `user.email is "${correo}", which is not an address of ${duenio}`);
  check("user.email no publica una direccion personal", correo.endsWith("@users.noreply.github.com"), `user.email is "${correo}"`);

  /* The author field in package.json. It said "ZendTay", a display name matching no
     account, and npm shows it on the package page. */
  const autor = String(paquete.author ?? "");

  check("package.json nombra al propietario, no un apodo", autor.startsWith(duenio), `package.json author is "${autor}"`);

  /* And the commit itself. Git rewrote the author with `git commit --amend` when
     the configuration changed, so a correct `user.email` next to an old commit means
     the commit has not been rebuilt — which is the state this repository was in. */
  const autorCommit = git("log", "-1", "--format=%ae");
  const nombreCommit = git("log", "-1", "--format=%an");

  check("el ultimo commit lo firma el propietario", autorCommit === correo, `the last commit is ${autorCommit} but user.email is ${correo}`);
  check("el nombre del ultimo commit es el propietario", nombreCommit === duenio, `the last commit says "${nombreCommit}"`);

  /* A commit is attributed by its email, and GitHub checks it against the account.
     An address on a domain nobody controls cannot be attributed, which is the whole
     failure, so the test is that the domain is GitHub's and not merely plausible. */
  check("el correo puede atribuirse a una cuenta de GitHub", /@users\.noreply\.github\.com$/.test(autorCommit), `"${autorCommit}" carries no GitHub account`);
}

if (fallos.length > 0) {
  console.error(`\n   ${fallos.length} problem(s) with the commit identity.`);
  console.error(`   The account is ${duenio}. Set it with:`);
  console.error(`     git config --local user.name ${duenio}`);
  console.error(`     git config --local user.email ${duenio}@users.noreply.github.com`);
  console.error(`   then rebuild the commit so it carries the new author.`);
  process.exitCode = 1;
}