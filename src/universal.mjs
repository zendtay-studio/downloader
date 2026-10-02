/**
 * Universal extractor: for links that belong to none of the platforms.
 *
 * The platform extractors are all different because each site hides its files
 * where it wants. When a link belongs to NONE of them, the problem reduces to
 * something far simpler: the page already wrote down where every file is, just
 * in ten different ways —a `<video>`, an `og:video`, a deferred `src`, embedded
 * JSON, a CSS `url()`— so it is enough to walk all of them.
 *
 * Two limits worth keeping in mind, because they are not implementation details
 * but rather about what this can and cannot do:
 *
 *  1. Only what the page DECLARES in its HTML is visible. If the file only exists
 *     after JavaScript runs, it is not here. No guessing what will appear and no
 *     invented URLs: what was found is returned, and it says there is nothing when
 *     there is nothing.
 *
 *  2. This turns the Worker into something that fetches addresses supplied by
 *     users, so they have to be filtered. Only `http` and `https` are requested,
 *     and host names pointing inside the network —`localhost`, `.local`,
 *     `.internal` and private IPs— are dropped so nobody can use it to reach
 *     something not on the internet. On Cloudflare's edge `fetch` only goes out
 *     to the internet anyway, but the filter is there anyway: it is cheap and
 *     does not depend on where this code runs.
 */
import { DESKTOP_USER_AGENT, explain, fetchPage, fetchTimed } from "./core.mjs";

/* ─────────────────────────────── 1. what counts as a file ─────────────────── */

/**
 * Extensions by type, and they decide whether a URL is a file or decoration.
 * Deliberately broad: the goal is not to lose anything, and the later probing is
 * what discards what is not really served.
 *
 * `m3u8` is a playlist, not a file. It sits under video so it is recognised, and
 * is then flagged as HLS so the page routes it through the proxy, the only thing
 * that knows how to handle segments.
 *
 * `mpd` (DASH) is left out on purpose. It is a real format, but the proxy only
 * walks HLS playlists, and returning an `.mpd` as if it were a segment list
 * would give a broken item. Better nothing than that.
 */
const EXTENSIONS = {
  video: new Set("mp4 m4v mov mkv webm ogv avi flv f4v wmv mpg mpeg m2ts mts ts 3gp 3g2 vob divx rm rmvb asf mxf mxfp m3u8".split(" ")),
  audio: new Set("mp3 m4a m4b aac ogg oga opus wav flac wma aiff aif amr mka m3u".split(" ")),
  image: new Set("jpg jpeg jpe jfif png gif webp avif bmp tiff tif svg heic heif apng".split(" ")),
};

const KIND_ORDER = ["video", "audio", "image"];

const PLAYLIST_EXTENSIONS = new Set(["m3u8", "m3u"]);

/**
 * Which kind a playlist is, by its own extension.
 *
 * `m3u8` is video and `m3u` is audio, and both are playlists. They used to be one
 * set, so a `.m3u` radio stream came out as `kind: "video"`: the card said video,
 * `/api/media` picked the video branch for it, and the extension came back wrong.
 * The `hls` marker is the same for both; only the kind differs.
 */
function kindOfPlaylist(ext) {
  return ext === "m3u" ? "audio" : "video";
}

/* ─────────────────────────────── 2. what may be requested ─────────────────── */

/**
 * Addresses that must never be requested, on a machine that can reach them.
 *
 * On a Cloudflare Worker this is defence in depth rather than the wall itself:
 * `fetch` there only reaches the internet, so there is nothing to reach *but* the
 * internet. It matters locally, where the same code runs on a laptop or a
 * developer's machine that is on a real network with a real router on it.
 *
 * Four shapes used to get through the string patterns and are handled by
 * parsing instead:
 *
 * - `fd00::/8`. The list had `fc[0-9a-f]{2}:` only, which is `fc00::/8`, and
 *   `fd` is the half of the range that actually turned up.
 * - `::ffff:127.0.0.1`, an IPv4 address written as IPv6. The v4 patterns never
 *   see it because the string starts with colons.
 * - `2130706433`, `127.1`, `0x7f.1`. `new URL` hands the hostname over as typed,
 *   so a decimal or short-form IPv4 arrives looking like an ordinary name and
 *   resolves to a loopback address.
 * - `::` and `0.0.0.0`, which are the unspecified address and do connect.
 */
const PRIVATE_NETWORKS = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./, // 0.0.0.0/8: "this network", which on a host means localhost
  // fc00::/7, the whole unique-local range: fc.. and fd..
  /^f[cd][0-9a-f]{2}:/i,
  // fe80::/10, link-local
  /^fe[89ab][0-9a-f]:/i,
  // ::1 loopback, :: unspecified, and the IPv4-mapped form
  /^::1$/, /^::$/, /^::ffff:/i,
];

const INTERNAL_NAMES = [/\.local$/i, /\.internal$/i, /\.home$/i, /^localhost$/i, /\.localhost$/i];

/**
 * Normalises a host that is really an IPv4 address written some other way, and
 * returns the dotted form or null when it is an ordinary name.
 *
 * `new URL` does not normalise these: `http://2130706433/` keeps the digits as
 * the hostname, and DNS-less resolvers still connect to 127.0.0.1. So the digits
 * are converted here before the v4 patterns get a chance to miss them.
 */
function normalizeIpv4(host) {
  /* Plain integer: 2130706433 -> 127.0.0.1 */
  if (/^\d{1,10}$/.test(host)) {
    const integer = Number(host);

    if (integer > 0xFFFFFFFF) return null;

    return [integer >>> 24, (integer >>> 16) & 255, (entario >>> 8) & 255, integer & 255].join(".");
  }

  const partes = host.split(".");

  if (partes.length < 2 || partes.length > 4) return null;

  const values = partes.map((entry) => {
    /* Each part is read in the base its own prefix says: `0x` is hexadecimal and
       one starting with 0 and nothing else is octal, which is the way
       0177.0.0.1 is written. A plain integer inside a dotted quad is octal
       too, unless it carries the 0x in front. */
    if (/^0x[0-9a-f]{1,2}$/i.test(entry)) return parseInt(entry.slice(2), 16);

    if (/^0\d+$/.test(entry)) return parseInt(entry.slice(1), 8);

    if (/^\d{1,2}$/.test(entry)) return Number(entry);

    return NaN;
  });

  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;

  return [values[0], values[1] ?? 0, values[2] ?? 0, values[3] ?? 0].join(".");
}

/** Whether a URL points somewhere a request must not go. */
export function isPublic(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!host) return false;
  if (INTERNAL_NAMES.some((pattern) => pattern.test(host))) return false;

  // An IPv4 written as IPv6: it is unwrapped and judged with the v4 patterns.
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);

  if (mapped) return isPublic(`http://${mapped[1]}/`);

  const asV4 = normalizeIpv4(host);

  if (asV4) return !PRIVATE_NETWORKS.some((pattern) => pattern.test(asV4));

  return !PRIVATE_NETWORKS.some((pattern) => pattern.test(host));
}

/* ─────────────────────────────── 3. reading attributes ────────────────────── */

/**
 * A tag's attributes, whatever order they come in.
 *
 * Needed because the order is not guaranteed: `og:video` arrives as `property`
 * before `content` on some sites and the other way round on others, and
 * `<video playsinline src=…>` does not put `src` first either. Parsing by
 * position would mean asking it to work by luck.
 */
function attributes(label) {
  const output = {};

  for (const m of label.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g)) {
    output[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }

  return output;
}

/** The extension of the path, lowercase and without the dot. */
function extensionFromUrl(url) {
  try {
    return new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ?? "";
  } catch {
    return "";
  }
}

function kindForExtension(ext) {
  return KIND_ORDER.find((kind) => EXTENSIONS[kind].has(ext)) ?? null;
}

/* ──────────────────────────── 4. collecting candidates ───────────────────── */

/**
 * Walks the HTML and returns a map of URL → where it came from.
 *
 * The first time a URL appears wins, so the order the walk runs in matters: the
 * tags where the site had to declare the file in order to obfuscate it come
 * first, because that is where intent is most reliable. The general sweep of
 * loose URLs goes last, when only untagged ones remain.
 */
function collect(html, base) {
  const collected = new Map();

  const record = (raw, kind, foundVia) => {
    if (typeof raw !== "string") return;

    const limpio = raw.trim().replace(/&amp;/g, "&");

    if (!limpio || limpio.startsWith("data:") || limpio.startsWith("blob:")) return;

    let absoluteUrl;

    try {
      absoluteUrl = new URL(limpio, base).href;
    } catch {
      return;
    }

    if (!isPublic(absoluteUrl)) return;
    if (collected.has(absoluteUrl)) return;

    const extension = extensionFromUrl(absoluteUrl);
    const category = kind ?? kindForExtension(extension);

    /* No type from the tag and no recognisable extension means skip: it may be a
       script, a stylesheet or an API. */
    if (!category) return;

    collected.set(absoluteUrl, { kind: category, extension, foundVia });
  };

  /* 1. Open Graph and Twitter: the site says what each thing is. */
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const name = (a.property ?? a.name ?? "").toLowerCase();

    if (!a.content) continue;

    if (/^og:video/.test(name) || name === "twitter:player:stream") {
      record(a.content, "video", "og:video");
    } else if (/^og:audio/.test(name)) {
      record(a.content, "audio", "og:audio");
    } else if (/^og:image/.test(name) || /^twitter:image/.test(name)) {
      record(a.content, "image", "og:image");
    }
  }

  /* 2. The page's own players. A `<source>`'s `type` beats the parent: a video
        with an audio track inside can happen, and then the audio is what
        matters. */
  for (const m of html.matchAll(/<(video|audio)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const [, name, openTag, body] = m;
    const kind = name.toLowerCase() === "video" ? "video" : "audio";

    record(attributes(`<x ${openTag}>`).src, kind, `<${name}>`);

    for (const s of body.matchAll(/<source\b([^>]*)>/gi)) {
      const a = attributes(`<x ${s[1]}>`);
      const category = (a.type ?? "").toLowerCase();

      if (category.startsWith("audio/")) record(a.src, "audio", "<source>");
      else if (category.startsWith("image/")) record(a.src, "image", "<source>");
      else record(a.src, kind, "<source>");
    }
  }

  /* 3. Unclosed `<video>` or `<audio>`: the HTML arrives broken, far more often
        than you would think, especially on old pages. */
  for (const m of html.matchAll(/<(video|audio)\b([^>]*?)\/?>/gi)) {
    if (/<(video|audio)\b[^>]*>[\s\S]*<\/(?:video|audio)\s*>/i.test(m[0])) continue;

    const kind = m[1].toLowerCase() === "video" ? "video" : "audio";

    record(attributes(`<x ${m[2]}>`).src, kind, `<${m[1]}>`);
  }

  /* 4. Images. On a normal site `src` is empty and the real one lives in
        `data-src`: the trick to avoid downloading photos until they are seen,
        and without this the sweep only finds thumbnails. */
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = attributes(`<x ${m[1]}>`);
    const source = a.src
      || a["data-src"]
      || a["data-original"]
      || a["data-lazy-src"]
      || a["data-actualsrc"]
      || a["data-original-src"];

    record(source, "image", "<img>");

    /* A `srcset` is "url 480w, url 1080w". Nothing says which is the largest,
       so they are all taken and the probing sorts them out. */
    for (const srcsetList of [a.srcset, a["data-srcset"]]) {
      if (!srcsetList) continue;

      for (const entry of srcsetList.split(",")) {
        const url = entry.trim().split(/\s+/)[0];

        if (url) record(url, "image", "srcset");
      }
    }
  }

  /* 5. `<link rel="preload" as="video">`: the site saying what will load. */
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attributes(`<x ${m[1]}>`);
    const rel = (a.rel ?? "").toLowerCase();
    const as = (a.as ?? "").toLowerCase();

    if (!/preload|prefetch/.test(rel) || !as) continue;
    if (as === "video") record(a.href, "video", "link preload");
    else if (as === "audio") record(a.href, "audio", "link preload");
    else if (as === "image") record(a.href, "image", "link preload");
  }

  /* 6. JSON-LD, where a serious site declares its content. */
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let datos;

    try {
      datos = JSON.parse(m[1].trim());
    } catch {
      continue;
    }

    const visit = (node, esMedio = false) => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child, esMedio);

        return;
      }

      if (!node || typeof node !== "object") return;

      const category = Array.isArray(node["@type"])
        ? node["@type"].join(" ")
        : String(node["@type"] ?? "");
      const medio = esMedio
        || /Video|Audio|Image|MediaObject|Movie|Music|Podcast|Clip|Recording/i.test(category);

      for (const field of ["contentUrl", "embedUrl", "thumbnailUrl", "url"]) {
        if (typeof node[field] !== "string") continue;
        /* The `url` of a `WebSite` or an `Organization` is the page itself, not a file.
           `url` values are only taken when the declared type is a media type. */
        if (field === "url" && !medio) continue;

        record(
          node[field],
          /Image/i.test(category) && field === "thumbnailUrl" ? "image" : null,
          "ld+json",
        );
      }

      for (const child of Object.values(node)) {
        if (child && typeof child === "object") visit(child, medio);
      }
    };

    visit(datos);
  }

  /* 7. The general sweep: any URL with a media extension appearing in the HTML,
        escaped or not. This is what catches embedded JSON, `url()` in
        stylesheets, `data-*` attributes and inline JavaScript with the file path
        written inside. Without it half a catalogue escapes. */

  const suffixes = [...new Set([...EXTENSIONS.video, ...EXTENSIONS.audio, ...EXTENSIONS.image])].join("|");
  const pattern = new RegExp(
    String.raw`https?:(?:\\?/\\?/)[^\s"'<>\\)\]]+?\.(?:${suffixes})(?:\?[^\s"'<>\\)\]]*)?`,
    "gi",
  );

  for (const m of html.matchAll(pattern)) {
    /* In embedded JSON the slashes are escaped: `https:\/\/…`. */
    record(m[0].replace(/\\\//g, "/"), null, "html");
  }

  return collected;
}

/* ──────────────────────────── 5. sorting and keeping ───────────────────── */

/**
 * How good a candidate is, so the best one comes first.
 *
 * Two signals, neither useful alone: the numbers in the path
 * (`video-1080p.mp4`, `imagen_1920x1080.jpg`) and whether the URL carries
 * resizing parameters. A `?w=320&h=240` is a thumbnail, and even if the path says
 * `1920` the file being served is the small one.
 */
function qualityScore(url) {
  let paths = url;

  try {
    const parsed = new URL(url);

    paths = parsed.pathname + parsed.search;
  } catch {}

  const dimensions = [...paths.matchAll(/(?:^|[^\d])(\d{3,4})[xp](\d{3,4})(?:[^\d]|$)/g)]
    .map((m) => Math.min(Number(m[1]), Number(m[2])));
  const heights = [...paths.matchAll(/(?:^|[^\d])(\d{3,4})p(?:[^\d]|$)/g)].map((m) => Number(m[1]));
  const maxHeight = Math.max(0, ...dimensions, ...heights);
  const isResized = /[?&](?:w|width|h|height|fit|resize|thumb|quality|q|stp)=/i.test(paths);

  return maxHeight * (isResized ? 0.4 : 1);
}

/** Two URLs with the same host and path are the same file with another token. */
function uniqueKey(url) {
  try {
    const parsed = new URL(url);

    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/* ──────────────────────────────── 6. the extractor ───────────────────────── */

/** How much HTML is read before giving up. 3 MB is plenty for a normal site. */
const MAX_HTML = 3 * 1024 * 1024;

/**
 * How many files are offered, per type.
 *
 * The count is what matters because each one is measured with network requests,
 * and the free plan gives fifty for the whole resolve. The page takes one, so
 * forty-nine remain; each measurement tries up to three URLs, so fifteen files
 * is what fits comfortably. Before sprawling over the whole page, better few and
 * good: videos and audios come first because that is what people come for, and
 * photos after.
 */
const MAX_PER_KIND = { video: 6, audio: 3, image: 8 };

function prefixOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "web";
  } catch {
    return "web";
  }
}

/** A single file, when the link IS the file. */
function directFile(url, kind, extension, referer) {
  return {
    files: [{
      media: [url],
      kind,
      isVideo: kind === "video",
      extension,
      ...(PLAYLIST_EXTENSIONS.has(extension) ? { hls: true, fmp4: false } : {}),
      accept: "^(video|audio|image|application/octet-stream|application/mp4|binary)",
      foundVia: "direct link",
    }],
    prefix: prefixOf(url),
    referer: referer ?? url,
    universal: true,
    truncated: false,
    found: 1,
  };
}

/**
 * The link looks like a file because its path ends in a media extension, but
 * that does not make it one.
 *
 * The case that forces the check is real: a Wikimedia file's page is
 * `…/wiki/File:something.ogg`, and what is there is a page, not the `.ogg`.
 * Without looking at what the server replies, the direct-link shortcut hijacks
 * it, sees HTML and says there is nothing —when the page has the file perfectly
 * declared inside.
 *
 * That is why it returns `null` instead of failing when the response is not a
 * media type: `null` means "this is a page, carry on with your usual path". An
 * error is only thrown when the 404 is unambiguous, which really does mean there
 * is nothing.
 */
async function probeFile(url, kind, extension) {
  let response;

  try {
    response = await fetchTimed(url, { headers: { Range: "bytes=0-0" } }, 6000);
  } catch {
    return null;
  }

  const httpStatus = response.status;
  const category = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  /* The body is not read: with a one-byte `Range` it comes back empty, and if the
     server ignores it, reading it whole would fill up the isolate's memory. */
  await response.body?.cancel().catch(() => {});

  if (httpStatus === 404 || httpStatus === 410) {
    throw explain(`The linked file does not exist (${httpStatus})`);
  }

  const esMedio = !category
    || /^(video|audio|image|application\/octet-stream|application\/mp4|binary|application\/ogg|application\/x-)/i.test(category);

  /* A 403 or a 429 with no clear type is accepted: the file may well be there and
     it is the network refusing, which is different from it not existing. A
     `text/html` is a page, and that is handed back to the caller so it carries on
     with the HTML. */
  if (!response.ok || !esMedio) return null;

  return directFile(url, kind, extension, null);
}

/**
 * The link has no extension, but the server may still be serving a media file: a
 * `…/stream/12345` is a video with no filename, which is how CDNs avoid showing
 * what they store.
 *
 * Only tried when the last path segment has no dot. If the link ends in `.html`
 * or any extension, it is a page and asking twice would spend a request for
 * nothing.
 */
async function probeDirect(url) {
  let ultimo;

  try {
    ultimo = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return null;
  }

  if (!ultimo || ultimo.includes(".")) return null;

  let response;

  try {
    response = await fetchTimed(url, { headers: { Range: "bytes=0-0" } }, 6000);
  } catch {
    return null;
  }

  const category = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  await response.body?.cancel().catch(() => {});

  if (!response.ok) return null;
  if (category.startsWith("video/")) return directFile(url, "video", "", null);
  if (category.startsWith("audio/")) return directFile(url, "audio", "", null);
  if (category.startsWith("image/")) return directFile(url, "image", "", null);

  return null;
}

/**
 * `/api/resolve` for a link that belongs to no platform.
 *
 * Returns the same shape as the platform extractors, so the page does not need
 * to know which path it came through. The only new thing is `universal: true`, so
 * the consumer can say so out loud instead of letting someone think the platform
 * was detected.
 */
export async function universal(source) {
  if (!isPublic(source)) {
    throw explain("That address is not valid: only http or https links are accepted");
  }

  /* 1. The link is already a file, or at least looks like one by extension. The
        most obvious case of all and the first to cover: someone pastes
        `…/video.mp4` and there is no page to walk. Without this the binary was
        requested, read as text as best it could, no media URL showed up inside
        and it ended up saying the page had nothing. */
  const extension = extensionFromUrl(source);
  const directKind = kindForExtension(extension);

  if (directKind) {
    /* A playlist is not probed: it is not a file, and the proxy already knows how to
       walk it. */
    if (PLAYLIST_EXTENSIONS.has(extension)) {
      return directFile(source, kindOfPlaylist(extension), extension, null);
    }

    const directo = await probeFile(source, directKind, extension);

    if (directo) return directo;

    /* The link ended in `.mp4` but the server replied with a page. It becomes
       one more page. */
  }

  /* 2. No extension: the server may be serving a media file anyway. */
  const unnamed = await probeDirect(source);

  if (unnamed) return unnamed;

  /* 3. It is a page: walk its HTML. */
  const page = await fetchPage(source, { "User-Agent": DESKTOP_USER_AGENT }, 0, MAX_HTML);

  if (!page.ok) {
    throw explain(page.status ? `The page responded ${page.status}` : "The page could not be opened");
  }

  const html = page.text ?? "";

  if (!html.trim()) throw explain("The page returned nothing to read");

  const base = page.url || source;
  const collected = collect(html, base);

  if (!collected.size) {
    throw explain("That page declares no video, audio or photo");
  }

  const files = [];
  const seen = new Set();

  for (const kind of KIND_ORDER) {
    const ofKind = [...collected.entries()].filter(([, dato]) => dato.kind === kind);

    ofKind.sort((a, b) => qualityScore(b[0]) - qualityScore(a[0]));

    let taken = 0;

    for (const [url, dato] of ofKind) {
      if (taken >= (MAX_PER_KIND[kind] ?? 0)) break;

      /* The same photo with two different tokens shows up twice in the sweep. One is
         kept, and the quality sort makes it the one without resizing
         parameters, which is the good one. */
      const key = uniqueKey(url);

      if (seen.has(key)) continue;

      seen.add(key);
      taken += 1;

      const esLista = PLAYLIST_EXTENSIONS.has(dato.extension);

      files.push({
        media: [url],
        kind,
        isVideo: kind === "video",
        extension: dato.extension,
        ...(esLista ? { hls: true, fmp4: false } : {}),
        /* The site has already said what type it is, so the probing cannot be
           strict: many serve an `.mkv` as `application/octet-stream`, and
           requiring `video/` strictly would discard them. */
        accept: "^(video|audio|image|application/octet-stream|application/mp4|binary)",
        foundVia: dato.foundVia,
      });
    }
  }

  if (!files.length) {
    throw explain("The files the page declares could not be verified");
  }

  return {
    files,
    prefix: prefixOf(base),
    /* The `Referer` when requesting the files is the page: nearly all open-web
       CDNs only serve requests coming from their own page. */
    referer: base,
    universal: true,
    truncated: page.truncated === true,
    /* What was found in the HTML, before trimming per type. Sent so there is a
       record of what was left out and why. */
    found: collected.size,
  };
}
