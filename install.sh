#!/usr/bin/env bash
#
# Installs `ddd` globally from a checkout of this repository.
#
#   git clone https://github.com/zendtay-studio/downloader.git
#   cd downloader
#   ./install.sh
#
# Two ways to install, and the difference matters:
#
#   ./install.sh            npm install -g .   → a symlink to this checkout
#   ./install.sh --copy     npm pack + install → a real copy, no symlink
#
# The default is the link because the point of a checkout is to change it, and a
# save should be a save. It is also a link, which is a fact npm does not print:
# `npm install -g .` does not copy the files, it points at the directory, so if
# this folder is moved or deleted `ddd` becomes a dangling symlink and the shell
# says `No such file or directory` — which names the missing file rather than the
# broken command. `--copy` is the way out of that, and it costs you updates: the
# installed copy does not change when this checkout does.
#
# Everything it needs is read from package.json rather than written here. The
# command's name, the file it lives in and the Node version required all live in
# one place already, and a second copy of any of them in this file would be one
# more thing to forget. Rename the `bin` entry in package.json and this follows.

set -euo pipefail

COPIA=0

for arg in "$@"; do
  case "$arg" in
    --copy) COPIA=1 ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n\nRun ./install.sh --help.\n' "$arg" >&2
      exit 1
      ;;
  esac
done

RAIZ="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$RAIZ"

if [ -t 1 ]; then
  OK=$'\033[32m'
  AVISO=$'\033[33m'
  FUERA=$'\033[31m'
  FIN=$'\033[0m'
else
  OK=""
  AVISO=""
  FUERA=""
  FIN=""
fi

paso() { printf '%s\n' "$*"; }
aviso() { printf '%s\n' "${AVISO}$*${FIN}" >&2; }
fallo() { printf '%s\n' "${FUERA}$*${FIN}" >&2; exit 1; }

# ── 1. is node here at all? ────────────────────────────────────────────────────
#
# Before anything is read out of package.json, because reading it needs node. And
# before that, the check has to work on whatever node is installed, so nothing
# here uses `?.` or any other recent syntax: a machine old enough to need this
# message is old enough that `?.` would be a syntax error, and the script would
# die on its own bootstrap instead of saying anything useful.

command -v node > /dev/null 2>&1 || fallo "node is not installed.
It is required, and this is a Node program. Install it from https://nodejs.org."

NODE_AQUI="$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || echo 0)"

case "$NODE_AQUI" in
  '' | *[!0-9]*)
    fallo "node answered with something that is not a version: '$NODE_AQUI'
Check with: node -v"
    ;;
esac

# ── 2. is this a checkout? ────────────────────────────────────────────────────

[ -f package.json ] || fallo "No package.json here.
Run this from inside the repository:
  git clone https://github.com/zendtay-studio/downloader.git
  cd downloader
  ./install.sh"

# Read what is needed out of package.json. `node -p` works even with
# "type": "module" in the file — checked, because assuming otherwise would make
# this script the first thing to break on an ESM package.
leer() { node -p "$1"; }

NOMBRE="$(leer "Object.keys(require('./package.json').bin)[0]")"
RUTA_BIN="$(leer "require('./package.json').bin['$NOMBRE']")"
# `engines.node` is a range expression in words, so the first number in it is the
      # one to compare against: ">=20" gives 20, and "^18 || >=20" gives 18. The
      # `|| ['']` is what keeps a version with no digits in it — or none at all —
      # from throwing and taking the script down before it can say anything.
NODE_PEDIDO="$(leer "(String((require('./package.json').engines || {}).node || '').match(/[0-9]+/) || [''])[0]")"

[ -n "$NOMBRE" ] || fallo "package.json has no bin entry, so there is no command to install."

[ -f "$RUTA_BIN" ] || fallo "package.json points the command at '$RUTA_BIN', and that file does not exist."

paso "command:  $NOMBRE  ->  $RUTA_BIN"
paso "checkout: $RAIZ"

# ── 3. is Node new enough? ────────────────────────────────────────────────────
#
# The comparison is on integers and nothing else. If the version could not be
# reduced to digits then there is nothing to compare against, and skipping a check
# silently is worse than not having one — so it says which check it is skipping
# and lets npm have the last word, which it does: an unsupported engine makes npm
# exit non-zero and this script stops there.
#
# It also has to be a real check. An earlier version compared against what
# `node -p` printed for a `match()`, which is the whole match array rendered as
# `['20', index: 2, input: '>=20', groups: undefined]` — `[` then refused to read
# it as an integer, the `if` never fired, and node 16 walked straight past a check
# written to stop it. Found by pretending to be an old node, not by reading it.

case "${NODE_PEDIDO:-}" in
  '' | *[!0-9]*)
    aviso "Could not read a Node version out of package.json, skipping the check."
    ;;
  *)
    if [ "$NODE_AQUI" -lt "$NODE_PEDIDO" ]; then
      fallo "node $NODE_AQUI is too old. This needs $NODE_PEDIDO or newer.
Check with: node -v"
    fi

    paso "node:     v$NODE_AQUI  (needs $NODE_PEDIDO or newer)"
    ;;
esac

# ── 4. npm present? ───────────────────────────────────────────────────────────

command -v npm > /dev/null 2>&1 || fallo "npm is not on the PATH.
It ships with node, so this usually means node was installed without it."

# ── 5. where does a global install land? ───────────────────────────────────────

PREFIX="$(npm prefix -g 2> /dev/null || true)"

[ -n "$PREFIX" ] || fallo "npm prefix -g printed nothing, so the global location is unknown.
Try: npm config get prefix"

BIN_GLOBAL="$PREFIX/bin"
paso "global:   $BIN_GLOBAL"

# ── 6. anything already installed? ─────────────────────────────────────────────

# Only ever touches this one package, and only by its own name. It does not go
# looking through node_modules for anything else, and a directory it did not put
# there is never removed.
if [ -e "$PREFIX/lib/node_modules/$NOMBRE" ] || [ -L "$PREFIX/lib/node_modules/$NOMBRE" ]; then
  paso ""
  aviso "There is already a $NOMBRE installed. It will be replaced."
fi

# ── 7. install ─────────────────────────────────────────────────────────────────

paso ""

if [ "$COPIA" -eq 1 ]; then
  TARBAL="$(node -p "require('./package.json').name + '-' + require('./package.json').version + '.tgz'")"

  paso "Packing, so the install is a copy rather than a link."

  # `npm pack` writes the tarball into this directory, and `prepack` builds
  # worker.js first. The file is removed afterwards whatever happens, because it is
  # a build artefact and leaving it behind would be littering the checkout.
  trap 'rm -f "$RAIZ/$TARBAL"' EXIT

  npm pack --silent > /dev/null
  npm install -g "./$TARBAL" --no-audit --no-fund > /dev/null

  paso "Installed a copy. It survives this folder being deleted."
  paso "It also does not change when this checkout does: run ./install.sh --copy again after a git pull."
else
  npm install -g . --no-audit --no-fund > /dev/null

  paso "Installed a link to this checkout."
  paso "Changes here take effect straight away."
  paso "Moving or deleting this folder breaks $NOMBRE. Keep it where it is,"
  paso "or use ./install.sh --copy for an install that does not depend on it."
fi

# ── 8. does it answer? ─────────────────────────────────────────────────────────

paso ""

if [ ! -x "$BIN_GLOBAL/$NOMBRE" ]; then
  fallo "npm reported success but there is no $NOMBRE in $BIN_GLOBAL.
Look for the error above this line."
fi

# Run it by path rather than by name. On PATH it might be a different $NOMBRE from
# an earlier install, and this is the one npm just made.
if SALIDA="$("$BIN_GLOBAL/$NOMBRE" --help 2>&1)"; then
  :
else
  fallo "$NOMBRE is installed but running it failed:
$SALIDA"
fi

case "$SALIDA" in
  "$NOMBRE "*) ;;
  *)
    fallo "$NOMBRE answered with something unexpected:
$SALIDA"
    ;;
esac

paso "${OK}Installed.${FIN} $("$BIN_GLOBAL/$NOMBRE" --help 2>&1 | head -1)"

# ── 9. can the shell find it? ──────────────────────────────────────────────────
#
# This is the step that silently ruins an install. npm writes the command into
# npm's own bin directory, and if that directory is not on the PATH then the
# install worked, the file is there, and every shell still answers
# `ddd: command not found`. It is not a failure of the install and nothing in
# npm's output mentions it.

case ":$PATH:" in
  *":$BIN_GLOBAL:"*)
    :
    ;;
  *)
    paso ""
    aviso "$BIN_GLOBAL is not on your PATH."
    aviso "$NOMBRE is installed and works, but a shell will not find it."
    aviso ""
    aviso "Add this to ~/.bashrc (or ~/.zshrc):"
    aviso ""
    aviso "    export PATH=\"$BIN_GLOBAL:\$PATH\""
    aviso ""
    aviso "Then open a new terminal, or run: source ~/.bashrc"
    ;;
esac

# A shell remembers where it last found a command, so one that has been looking
# for a $NOMBRE that was not installed keeps answering with the old path even
# after the file appears. There is no way to fix another shell from in here.
paso ""
paso "In a terminal that was already open before this ran:"
paso "    hash -r"
paso ""
paso "Then try:"
paso "    $NOMBRE --help"