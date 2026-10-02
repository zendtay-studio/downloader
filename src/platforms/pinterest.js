/* Pinterest. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  DESKTOP_USER_AGENT,
  withStatus,
  cookieHeader,
  cookieValue,
  explain,
  fetchPage,
} from "../core.mjs";


/** Numeric id of a pin: /pin/<slug>-<id> or /pin/<id>. */
function extractPinterestId(value) {
  return String(value ?? "").match(/pinterest\.[a-z.]+\/pin\/(?:[^/?#]*?-)?(\d{6,})/i)?.[1]
    ?? String(value ?? "").match(/pinterest\.[a-z.]+\/pin\/(\d{6,})/i)?.[1]
    ?? null;
}

/** Finds the first object inside ld+json that matches the predicate. */
function deepFind(root, predicate) {
  const stack = [root];
  const seen = new WeakSet();

  while (stack.length) {
    const value = stack.pop();

    if (!value || typeof value !== "object" || seen.has(value)) continue;

    seen.add(value);

    if (predicate(value)) return value;

    for (const child of Object.values(value)) stack.push(child);
  }

  return null;
}


function pinterestJsonBlocks(html) {
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

  return [...html.matchAll(pattern)].flatMap((match) => {
    try {
      const data = JSON.parse(match[1].replace(/\u003c/g, "<").replace(/\u0026/g, "&"));
      return Array.isArray(data) ? data : [data];
    } catch {
      return [];
    }
  });
}

/**
 * The routes tried, in order of cost.
 *
 * It used to request only `/pin/{id}/`. With that, a degraded response —which is
 * what arrives from Cloudflare— was a complete failure, because there was no
 * second place to look. These three complement each other: the first weighs 551
 * bytes, the second brings the video and the third the originals even when the
 * `ld+json` is missing.
 *
 * The oembed goes with the pin's full URL rather than the bare id, because with
 * the id it answers 400 on pins whose link carries a shop name.
 */


/**
 * The routes tried, in order of cost.
 *
 * It used to request only `/pin/{id}/`. With that, a degraded response —which is
 * what arrives from Cloudflare— was a complete failure, because there was no
 * second place to look. These three complement each other: the first weighs 551
 * bytes, the second brings the video and the third the originals even when the
 * `ld+json` is missing.
 *
 * The oembed goes with the pin's full URL rather than the bare id, because with
 * the id it answers 400 on pins whose link carries a shop name.
 */
function pinterestSources(id, source) {
  const pin = source && /pinterest\.[a-z.]+\/pin\//i.test(source) ? source : `https://www.pinterest.com/pin/${id}/`;

  return [
    { name: "oembed", url: `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(pin)}` },
    { name: "pin", url: `https://www.pinterest.com/pin/${id}/` },
    { name: "embed", url: `https://www.pinterest.com/embed/${id}/` },
  ];
}

/**
 * What is extracted from a Pinterest response.
 *
 * The `ld+json` blocks are looked at first, since that is where it comes clean.
 * And if there is nothing there, the whole HTML is swept: measured, the `mp4` and
 * the `pinimg.com/originals` appear on the page even when the JSON block is
 * missing, so that sweep rescues the cases where Pinterest serves the page
 * without the structured data —exactly what happens with datacenter IPs.
 */


/**
 * What is extracted from a Pinterest response.
 *
 * The `ld+json` blocks are looked at first, since that is where it comes clean.
 * And if there is nothing there, the whole HTML is swept: measured, the `mp4` and
 * the `pinimg.com/originals` appear on the page even when the JSON block is
 * missing, so that sweep rescues the cases where Pinterest serves the page
 * without the structured data —exactly what happens with datacenter IPs.
 */
function pinterestDelHtml(html, allowVideo) {
  const blocks = pinterestJsonBlocks(html);

  const video = allowVideo
    ? deepFind(blocks, (node) => typeof node.contentUrl === "string" && /\.mp4(?:$|\?)/i.test(node.contentUrl))
    : null;

  const poster = deepFind(blocks, (node) => typeof node.thumbnailUrl === "string" && /pinimg\.com/i.test(node.thumbnailUrl));
  const foto = deepFind(blocks, (node) => typeof node.image === "string" && /pinimg\.com\/originals\//i.test(node.image));

  if (video || poster || foto) return { video, poster, foto };

  // El barrido. Se cogen las URL enteras del HTML, sin procesar, y se limpian los
  // caracteres de escape promise Pinterest deja puesto (`\/`, `\u002F`, `&amp;`).
  const unescapeHtml = (value) => value.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/\\u002F/gi, "/");

  const mp4 = allowVideo
    ? [...html.matchAll(/https:[\\/]{2}[^"'\s\\]{20,400}?\.mp4(?:\?[^"'\s\\]{0,160})?/gi)]
        .map((m) => unescapeHtml(m[0]))
        .find((u) => /videos\/(?:mc|av)|\.mp4/i.test(u))
    : null;

  const originals = [...html.matchAll(/https:[\\/]{2}i\.pinimg\.com[\\/]{2}originals[\\/][^"'\s\\]{6,200}/gi)]
    .map((m) => unescapeHtml(m[0]));

  return {
    video: mp4 ? { contentUrl: mp4 } : null,
    poster: poster ?? null,
    foto: originals[0] ? { image: originals[0] } : null,
  };
}

/** Video, cover or original image of a Pinterest pin. */


/** Video, cover or original image of a Pinterest pin. */
async function fetchPinterestMedia(id, source) {
  const headers = {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    /* A consent cookie of our own. Without it Pinterest serves EU IPs a page
       with the cookie notice and no pin inside, which is exactly what is seen
       from Cloudflare's edge. It is always sent, and on its own it does no harm:
       it is one of the same cookies the site already sets. */
    ...cookieHeader("PIN_COOKIE"),
    ...(cookieValue("PIN_COOKIE") ? {} : { Cookie: "cookie_consent=Iu14; csrftoken=0e0e0e" }),
  };

  const html = [];
  let ultimoEstado = 0;

  for (const source of pinterestSources(id, source)) {
    const page = await fetchPage(source.url, headers, 0, 0);

    if (!page.ok || !page.text) {
      ultimoEstado = page.status;
      continue;
    }

    const limpio = page.text.replace(/\\\//g, "/");
    html.push(limpio);

    /* Stop as soon as there is a video. The oembed is the lightest —551 bytes—
       and sometimes already has what is needed, but it only brings the
       thumbnail: if it always stopped there, a pin with video would be left
       without it, which is precisely the main case. */
    const fetched = pinterestDelHtml(limpio, true);
    if (fetched.video) break;
  }

  if (!html.length) throw withStatus(new Error(`Pinterest responded ${ultimoEstado || "no data"}`), Number(ultimoEstado) || 502);

  const joinedHtml = html.join("\n");

  const extracted = pinterestDelHtml(joinedHtml, true);

  const { video, poster, foto } = extracted;
  const files = [];

  if (video) {
    // Pinterest offers higher quality variants in the Relay: the best is sought.
    const hash = video.contentUrl.match(/\/videos\/mc\/[^/]+\/([0-9a-f/]+?)(?:_t\d+)?\.mp4/i)?.[1];
    const better = hash
      ? ["1080p", "720p", "expMp4"]
          .map((quality) => joinedHtml.match(new RegExp(`(https:\\/\\/[^"\\s]*\\/videos\\/mc\\/${quality}\\/${hash.replace(/[/.]/g, (c) => `\\${c}`)}\\.mp4)`, "i"))?.[1])
          .find(Boolean)
      : null;

    files.push({ media: [better ?? video.contentUrl], isVideo: true, kind: "video", extension: "mp4" });
  }

  if (video && poster) {
    files.push({ media: [poster.thumbnailUrl], isVideo: false, kind: "image" });
  } else if (foto && !video) {
    files.push({ media: [foto.image], isVideo: false, kind: "image" });
  } else if (poster && !video) {
    files.push({ media: [poster.thumbnailUrl], isVideo: false, kind: "image" });
  }

  if (!files.length) throw explain("That Pinterest pin has no downloadable images or video");

  return files;
}

/* --------------------------------------------------------------- Threads --
 *
 * Threads hides its content on purpose: the initial document is 277 KB of
 * JavaScript shell with no og tag, no post code and no media in it. All of that
 * arrives later, in the Relay payload the page embeds, and only if the document
 * is requested the way a browser requests it.
 *
 * There is nothing about the video in the tags: the file comes from
 * `video_dash_manifest`, a DASH manifest with one entry per quality and the URL
 * already signed. Photos come from `image_versions2`.
 */

/**
 * The headers that make Threads deliver the post instead of the shell. With only
 * Chrome's User-Agent it answers 200 with the shell; with navigation `Sec-Fetch`
 * it answers with the content.
 */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectPinterest(source) {
  const id = extractPinterestId(source);
  if (!id) return null;

  return {
    files: await fetchPinterestMedia(id, source),
    prefix: `pinterest-${id}`,
    referer: "https://www.pinterest.com/",
  };
}
