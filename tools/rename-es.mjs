/* Renames Spanish identifiers to English across the repo.
 *
 * A plain regex over the file would be wrong in three ways that all show up here:
 *
 *   - `es.pornhub.com` and `lang=es` are URLs. Rewriting those breaks the
 *     extractor against the real site, and nothing else would notice.
 *   - Spanish inside a string is sometimes text and sometimes an expression:
 *     `'${tamano(recibidos)}'` has to change and `'error'` has not to.
 *   - `ancho:` in an object literal is a key as well as a name, so it has to move
 *     with every read of it or the object silently loses a field.
 *
 * So this walks the source and keeps four kinds of region apart — code, comments,
 * string text, and the `${...}` expressions inside templates. Only code and
 * comments get renamed; string text is left exactly as written.
 *
 * The mapping is passed in. It is decided in one place, on purpose: five agents
 * picking their own English for `salida` leaves three spellings of one idea, which
 * is a worse mess than the Spanish ever was.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

const RAIZ = new URL("../", import.meta.url).pathname;

/* Identifiers, chosen once. Compound names get natural English rather than a
   word-for-word swap, because `salidaContada` → `outputContada` would still be
   half Spanish. */
const MAPA = {
  // core.mjs, shared by every platform
  esPublica: "isPublic",
  mejorVariante: "bestVariant",
  variante: "variant",
  normalizaIpv4: "normalizeIpv4",
  interactivo: "interactive",
  ficheros: "files",
  fichero: "file",
  archivos: "files",
  archivoDirecto: "directFile",
  sondearArchivo: "probeFile",
  ssstikArchivos: "ssstikFiles",

  // api.mjs
  opciones: "options",
  salida: "output",
  entrada: "input",
  respuesta: "response",
  elegido: "chosen",
  ancho: "width",
  alto: "height",
  cuerpo: "body",
  cuerpoHls: "hlsBody",
  linea: "line",
  lineas: "lines",
  enlace: "link",
  codigo: "code",
  intento: "attempt",
  conAlto: "withHeight",
  isSinPlataforma: "isWithoutPlatform",
  sitio: "site",
  Sitio: "site",
  marcado: "ticked",

  // bin/
  elegir: "choose",
  elegirConFlechas: "chooseWithArrows",
  elegirSinPreguntar: "chooseWithoutAsking",
  marcados: "ticked",
  conProgreso: "withProgress",
  progreso: "progress",
  tamano: "size",
  salidaContada: "countedOutput",
  entradaAsk: "askInput",

  // tools/og.mjs — SVG constants, renamed to match their new casing
  ANCHO: "WIDTH",
  ALTO: "HEIGHT",
  FICHEROS: "FILES",
  POR_LINEA: "PER_LINE",
  PARECE_ENLACE: "LOOKS_LIKE_LINK",
  FALLOS_DEL_SERVIDOR: "SERVER_FAILURES",
  SIN_PLATAFORMA: "WITHOUT_PLATFORM",
  // ── added by the audit: identifiers with one meaning, safe everywhere ──

  // shared
  conEstado: "withStatus",
  nombre: "name",
  nombres: "names",
  valor: "value",
  valores: "values",
  estado: "state",
  fallos: "failures",
  ruta: "paths",
  esperado: "expected",
  tipo: "kind",
  cola: "queue",
  inicio: "start",
  enCurso: "running",
  pagina: "page",
  anotar: "record",
  etiqueta: "label",
  nodo: "node",
  caratula: "cover",
  texto: "text",
  absoluta: "absoluteUrl",
  manifiesto: "manifest",
  titulo: "title",
  resultado: "result",
  entero: "integer",
  leidos: "read",
  recibidos: "received",
  pista: "track",
  patron: "pattern",
  patrono: "pattern",
  campo: "field",
  visitar: "visit",
  bloque: "block",
  bloques: "blocks",
  direccion: "fileUrl",
  unido: "joined",
  secretos: "secrets",
  pedido: "retryAfter",
  hijo: "child",
  vistos: "seen",
  cogidos: "taken",
  delTipo: "ofKind",
  clave: "key",
  tipoDirecto: "directKind",
  reserva: "fallback",
  elegida: "chosen",
  nivel: "depth",
  mensaje: "message",
  mensajeDe: "messageFrom",
  caracter: "char",
  sospechosos: "suspects",
  totales: "total",
  coincidencia: "match",
  motivo: "reason",
  temporal: "tempFile",
  funcion: "run",
  donde: "where",
  originales: "originals",
  traido: "fetched",
  htmlUnido: "joinedHtml",
  pinterestFuentes: "pinterestSources",
  maestro: "master",
  cabeceras: "headers",
  pedirSesion: "postSession",
  calidades: "renditions",
  candidatas: "candidates",
  suelta: "looseCid",
  primer: "firstCid",
  portada: "cover",
  ajena: "thirdParty",
  deSuCdn: "fromTikcdn",
  envoltura: "wrapper",
  letra: "letter",
  descifrarSsstik: "decodeSsstik",
  tokenDesde: "tokenSince",
  relleno: "padding",
  recoger: "collect",
  crudo: "raw",
  apertura: "openTag",
  fuente: "source",
  fuentes: "sources",
  sufijos: "suffixes",
  mapeada: "mapped",
  comoV4: "asV4",
  calidad: "qualityScore",
  claveUnica: "uniqueKey",
  medidas: "dimensions",
  verticales: "heights",
  maxima: "maxHeight",
  reescalado: "isResized",
  prefijoDe: "prefixOf",
  extensionDe: "extensionOf",
  tipoDeExtension: "kindForExtension",
  kindDeLista: "kindOfPlaylist",
  sondearDirecto: "probeDirect",
  semilla: "seed",
  vale: "usable",
  truncado: "truncated",
  soloMedidas: "onlyDimensions",
  indice: "eq",
  videoNumerico: "videoNumeric",
  youtubeNumerico: "youtubeNumeric",
  desconocido: "unknown",

  // selectors and prompts, bin/
  unidades: "units",
  proporcion: "ratio",
  llenos: "filled",
  velocidad: "speed",
  barra: "bar",
  segundos: "seconds",
  ultimoDibujo: "lastDraw",
  activo: "enabled",
  dibujar: "draw",
  rango: "range",
  malo: "errorText",
  listo: "done",
  regla: "divider",
  pintadas: "printed",
  aqui: "isCurrent",
  marca: "mark",
  restaurar: "restore",
  fuera: "finished",
  acabar: "finish",
  alPulsar: "onKeypress",
  promesa: "promise",
  desde: "from",
  hasta: "to",
  forzado: "forced",

  // cli flags
  ORDEN: "KIND_ORDER",
  argumentos: "parseArgs",
  porTipo: "byKind",
  posicion: "position",
  sueltos: "loose",
  AYUDA: "HELP",
  ayuda: "help",
  preguntar: "ask",
  diagnostico: "diagnose",
  porque: "why",
  principal: "main",
  esProgramaPrincipal: "isMainProgram",
  siguiente: "nextPart",
  conOrigen: "onOrigin",

  // the tools
  MARGEN: "MARGIN",
  TINTA: "INK",
  DESTINO: "TARGET",
  RAIZ: "ROOT",
  PAGINA: "PAGE_PATH",
  fondo: "background",
  subtitulo: "subtitle",
  divisoria: "divider",
  pie: "footer",
  comprobar: "check",
  rasterizar: "rasterize",
  reescrita: "rewritten",
  faltan: "missing",
  sobran: "extra",
  carpeta: "isDir",
  OFRECE: "OFFERS",
  DEFINIDO: "DEFINED",
  importados: "imported",
  propios: "own",
  sinImportar: "missing",
  fantasma: "ghost",
  existe: "exists",
  comprobados: "checked",
  correr: "run",
  FUENTES: "SOURCES",

  // constants that read as Spanish in caps
  TOPES: "MAX_PER_KIND",
  TIPOS: "EXTENSIONS",
  LISTAS: "PLAYLIST_EXTENSIONS",
  ORDEN_TIPOS: "KIND_ORDER",
  REDES_PRIVADAS: "PRIVATE_NETWORKS",
  NOMBRES_INTERNOS: "INTERNAL_NAMES",
  ARRIBA: "UP",
  ABAJO: "DOWN",
  ESPACIO: "SPACE",

  // tests
  que: "promise",
  conPlazo: "withDeadline",
  conSegmentoPrivado: "withPrivateSegment",
  sinTerminal: "noTerminal",
  sinUrl: "noUrl",
  sinRef: "noRef",
  preguntaForzada: "forcedPrompt",
  servir: "startServer",
  recibido: "received",
  cerrar: "close",
  secreto: "secret",
  interno: "internalServer",
  filtrado: "filtered",
  impreso: "printedCount",
  puerto: "port",
  temporizador: "timer",
  rechazar: "reject",
  falsificios: "forgeries",
  reales: "genuine",
  privada: "privateRes",
  esquema: "scheme",
  resuelve: "resolved",
  detalle: "detail",
  vacia: "emptied",
  llena: "filled",
};

const IDENT = /[A-Za-z_$][\w$]*/g;

/**
 * Splits source into runs, each tagged with whether it may be renamed.
 *
 * `code` and `comment` may: comments name the identifiers they talk about, and
 * leaving `salida` in a comment that describes the renamed `output` is worse than
 * useless. `text` may not, and it is `text` that holds the URLs.
 */
export function trocear(src) {
  const partes = [];
  let i = 0;
  let inicio = 0;

  const cerrar = (fin, tipo) => {
    if (fin > inicio) partes.push({ txt: src.slice(inicio, fin), tipo });
    inicio = fin;
  };

  /**
   * Runs to the end of a template literal, descending into each `${...}`
   * expression as code. `i` is the index of the opening backtick, so the scan
   * starts one past it.
   */
  const plantilla = (i) => {
    let j = i + 1;

    while (j < src.length) {
      const c = src[j];

      if (c === "\\") { j += 2; continue; }

      if (c === "`") {
        cerrar(j + 1, "text");
        return j + 1;
      }

      if (c === "$" && src[j + 1] === "{") {
        cerrar(j, "text");
        // The expression is code: find its end, tracking nesting and strings.
        let k = j + 2;
        let prof = 1;

        while (k < src.length && prof > 0) {
          const d = src[k];

          if (d === "\\") { k += 2; continue; }
          if (d === "'" || d === '"') {
            const fin = finCadena(src, k);
            cerrar(k, "code");
            cerrar(fin + 1, "text");
            k = fin + 1;
            continue;
          }
          if (d === "`") {
            /* The code in front of a nested template is closed as code before
               recursing. `plantilla` opens its own region with `cerrar(k, "text")`,
               and without this line that call would be the one closing the region
               the `${` opened — so everything from `${` to the nested backtick was
               tagged as text and none of it was renamed.

               It fails silently. The code still parses, the tests still pass, and
               the identifiers are simply still Spanish. The shape that triggers it
               is `lines.map((linea, i) => \`...\`)` inside a template, which is
               exactly what tools/og.mjs does with the platform names, and the first
               symptom was a `${esc(linea)}` that no longer had a `linea` to
               resolve to — a ReferenceError in a generator nobody was running. */
            cerrar(k, "code");
            const fin = plantilla(k);
            k = fin;
            continue;
          }
          if (d === "{") prof += 1;
          if (d === "}") prof -= 1;

          if (prof === 0) break;
          k += 1;
        }

        // From the `{` to the matching `}` is code.
        cerrar(k + 1, "code");
        j = k + 1;
        continue;
      }

      j += 1;
    }

    cerrar(src.length, "text");
    return src.length;
  };

  /**
   * Does the `/` at `i` open a regular expression, or is it a division?
   *
   * There is no way to be certain without parsing — `a / b / c` and `a /= b` are
   * both legitimate and only the grammar tells them apart. So this looks at what
   * came before, which is right for every case in this repository: a `/` after a
   * name, a number, `)`, `]` or `}` is division, and anywhere else it opens a
   * pattern. Getting one of these backwards is not silent — a pattern misread as
   * division swallows the following string and desynchronises the file, which is
   * the failure this is here to prevent.
   */
  const abreRegex = (s, i) => {
    for (let k = i - 1; k >= 0; k -= 1) {
      const c = s[k];

      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;

      if (/[A-Za-z0-9_$)\]]/.test(c)) return false;

      /* Keywords that take a regular expression after them, which is exactly the
         case that would otherwise look like division. */
      const antes = s.slice(Math.max(0, k - 12), k + 1);
      if (/\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(antes)) {
        return true;
      }

      return true;
    }

    return true;
  };

  /** Runs to the end of the pattern at `i`, and past its flags. */
  const regex = (i) => {
    let j = i + 1;
    let enClase = false;

    while (j < src.length) {
      const c = src[j];

      if (c === "\\") { j += 2; continue; }
      if (c === "[") { enClase = true; j += 1; continue; }
      if (c === "]") { enClase = false; j += 1; continue; }

      /* A `/` inside a character class is a literal slash, not the end. `[^\]"]`
         has one and stopping there cuts the pattern in half. */
      if (c === "/" && !enClase) break;

      j += 1;
    }

    j += 1;

    while (j < src.length && /[a-z]/.test(src[j])) j += 1;

    cerrar(j, "text");
    return j;
  };

  /** Returns the index of the closing quote of the string starting at `i`. */
  const finCadena = (s, i) => {
    const q = s[i];
    let j = i + 1;

    while (j < s.length) {
      if (s[j] === "\\") { j += 2; continue; }
      if (s[j] === q) return j;
      j += 1;
    }

    return s.length;
  };

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (c === "/" && d === "/") {
      cerrar(i, "code");
      let j = src.indexOf("\n", i);
      if (j === -1) j = src.length;
      cerrar(j, "comment");
      i = inicio = j;
      continue;
    }

    if (c === "/" && d === "*") {
      cerrar(i, "code");
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? src.length : j + 2;
      cerrar(j, "comment");
      i = inicio = j;
      continue;
    }

    if (c === "'" || c === '"') {
      cerrar(i, "code");
      const fin = finCadena(src, i);
      cerrar(fin + 1, "text");
      i = inicio = fin + 1;
      continue;
    }

    if (c === "`") {
      cerrar(i, "code");
      i = inicio = plantilla(i);
      continue;
    }

    /* A regular expression is a region of its own, and skipping it is not an
       optimisation: a pattern like /import\s*\{[^}]*\}\s*from\s*"\.[^"]*"/g
       contains both a quote and braces, and reading the quote as the start of a
       string desynchronises every tag after it. The whole rest of the file then
       looks like text and nothing in it gets renamed — which is not a partial
       result, it is an inconsistent one: the keys in an object literal get
       renamed and the code reading them does not, and the file stops working.
       That is exactly what happened to tools/build.mjs before this existed.
       (It takes two typos in a row to type `constPlantilla` and `Plantilla`, so
       also note that this file had never been run before it was needed.) */
    if (c === "/" && abreRegex(src, i)) {
      cerrar(i, "code");
      i = inicio = regex(i);
      continue;
    }

    i += 1;
  }

  cerrar(src.length, "code");
  return partes;
}

/* A Spanish word that means two different things in two different files.
 *
 * About seventeen of them: `nombre` is a name in the page extractor and a filename
 * in the build tool, `trozo` is a typed character in the CLI and a run of bytes in
 * the HTTP layer, `parte` is an episode number, an octet of an address and an item
 * of a srcset. One global entry cannot say that, and picking one of the meanings
 * makes the other file read wrong — which is the whole reason this was a mess to
 * begin with.
 *
 * So these are per file, and they win over the global map. Two of them cross a
 * module boundary and both sides have to move together:
 *
 *   `directo` is written into `files[]` by the TikTok extractor and read back as
 *   `file.directo` in the API. Both files map it to `direct`, so the contract
 *   holds; mapping only the writer would have left the reader looking for a key
 *   that is no longer there.
 *
 *   `conEstado` is exported by core and imported by ten platform files. It is the
 *   one name that has to be right for the whole tree at once.
 */
const POR_FICHERO = {
  /* The page's inline script, renamed through the same splitter. `INK.valor` is an
   average luminance rather than a value in general, so `average` says what it is;
   `lienzo` is the `<canvas>` it is drawn on. */
  "index.html": {
    valor: "average",
    lienzo: "canvas",
    margen: "margin",
    brusco: "sharp",
    salto: "delta",
    gris: "grey",
    filas: "rows",
    alfa: "alpha",
    numeros: "numbers",
    yaTraducido: "alreadyTranslated",
    lista: "list",
  },

  "src/universal.mjs": {
    nombre: "name",
    // `kind` already exists as a parameter in sondearArchivo, so `tipo` cannot
    // become `kind` there without redeclaring it. `category` reads the same in
    // both functions it appears in and collides with nothing.
    tipo: "category",
    pagina: "page",
    parte: "entry",
    atributos: "attributes",
    lista: "srcsetList",
    sinNombre: "unnamed",
    estado: "httpStatus",
    hallados: "collected",
    // The key it writes into `files[]`. Nobody reads it, so the rename is safe,
    // but the value is where it was found, not where it came from.
    origen: "foundVia",
    /* core.mjs has its own `extensionOf`, which resolves a value against the list
       of known extensions. This one pulls the extension off a URL path. The Worker
       build flattens both files into one scope, so the names have to differ and
       `extensionOf` was already taken. */
    extensionDe: "extensionFromUrl",
  },
  "src/platforms/tiktok.js": {
    pagina: "homeUrl",
    trozo: "segment",
    ultimo: "lastCall",
    final: "finalUrl",
    directo: "direct",
    espera: "cooldown",
    consulta: "queryUrl",
    ssstikPregunta: "ssstikFetch",
  },
  "src/platforms/threads.js": {
    atributos: "attrs",
    trozo: "slice",
    destino: "targetUrl",
  },
  "src/platforms/bilibili.js": {
    parte: "part",
    partes: "parts",
  },
  "src/platforms/pinterest.js": {
    nombre: "name",
    valor: "value",
    encontrado: "extracted",
    limpiar: "unescapeHtml",
  },
  "src/platforms/vimeo.js": {
    piso: "rung",
    /* `archivos` here is the object the Vimeo API hands back, and the file already
       had an English `files` for the array it returns. Both landing on `files` is a
       redeclaration in one block, which the Worker build rejects — and it was worth
       naming apart anyway: one is somebody else's data, the other is ours. */
    archivos: "metaFiles",
  },
  "bin/cli.mjs": {
    nombre: "filename",
    final: "filename",
    lista: "printList",
    todo: "savedFiles",
  },
  "bin/select.mjs": {
    // The two `hay` in this file ask different questions — is there a terminal,
    // and which kinds are available — so neither reads right as the other.
    hay: "available",
    trozo: "token",
    valor: "selection",
  },
  "tools/og.mjs": {
    nombre: "name",
    nombres: "names",
    sinNombre: "nameless",
    partes: "messages",
    destino: "destPath",
  },
  "tools/imports.mjs": {
    nombre: "fileName",
    linea: "lineNo",
  },
  "tools/status.mjs": {
    linea: "lineNo",
    nombre: "fileName",
  },
  "tools/syntax.mjs": {
    nombre: "fileName",
  },
  "tools/build.mjs": {
    nombre: "fileName",
  },
};

export function renombrar(src, rel) {
  const partes = trocear(src);
  const local = POR_FICHERO[rel] ?? {};
  let cuentas = 0;

  const salida = partes.map(({ txt, tipo }) => {
    if (tipo === "text") return txt;

    /* `hasOwn`, never a bare lookup. A map written as an object literal inherits
       from Object.prototype, so `MAPA.toString` is the inherited function rather
       than undefined — truthy, and splicing it into the source replaced every
       `.toString()` in the tree with the text `function toString() { [native code]
       }`. It stayed silent because the files still parsed and the tests passed:
       a string of that shape is not a syntax error, it is just wrong. Seven files
       were hit, and the giveaway was not any check but the rename being
       idempotent, which it was not. */
    return txt.replace(IDENT, (id) => {
      if (Object.hasOwn(local, id)) {
        cuentas += 1;
        return local[id];
      }

      if (Object.hasOwn(MAPA, id)) {
        cuentas += 1;
        return MAPA[id];
      }

      return id;
    });
  });

  return { texto: salida.join(""), cuentas };
}

async function* ficheros(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* ficheros(p);
    else if ([".mjs", ".js"].includes(extname(e.name))) yield p;
  }
}

/* Guarded, so that a test can import the splitter above without the import itself
   walking the tree and rewriting half of it. `import.meta.main` would say this
   more directly but it is not in this Node. */
function esEsteElPrograma() {
  if (!process.argv[1]) return false;

  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (esEsteElPrograma()) {
  const DRY = process.argv.includes("--dry");
  const tocados = [];
  let total = 0;

  for await (const ruta of ficheros(RAIZ)) {
    const rel = ruta.slice(RAIZ.length);

    /* Generated, or this file. Renaming the tool would rename the keys of its own
       MAPA, and the next run would have nothing to match: it works once and then
       reports 0 renames, which reads as "already done" rather than as a tool that
       has quietly emptied its own dictionary. */
    if (rel === "worker.js" || rel === "tools/rename-es.mjs") continue;

    const src = await readFile(ruta, "utf8");
    const { texto, cuentas } = renombrar(src, rel);

    if (cuentas) {
      total += cuentas;
      tocados.push([rel, cuentas]);
      if (!DRY) await writeFile(ruta, texto);
    }
  }

  tocados.sort((a, b) => b[1] - a[1]);

  for (const [rel, n] of tocados) console.log(`  ${String(n).padStart(4)}  ${rel}`);

  console.log(`\n  ${total} renombrados en ${tocados.length} ficheros${DRY ? " (dry)" : ""}`);
}