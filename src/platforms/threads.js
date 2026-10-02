/* Threads. Everything that knows about this one site lives here and
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
  explain,
  fetchPage,
} from "../core.mjs";


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
const THREADS_NAV_HEADERS = {
  "User-Agent": DESKTOP_USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Chromium";v="140"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/** Post code: /share/{code}, /t/{code} or /@user/post/{code}. */


/** Post code: /share/{code}, /t/{code} or /@user/post/{code}. */
function extractThreadsCode(source) {
  return String(source ?? "").match(
    /threads\.(?:com|net)\/(?:share\/|t\/|@[^/?#]+\/post\/)([A-Za-z0-9_-]{8,24})/i,
  )?.[1] ?? null;
}

/**
 * The payload travels inside a JSON that escapes its own strings, and the HTML
 * escapes `&` on top of that. Without undoing all of it the URLs come out badly
 * signed and the CDN answers 403 with twelve bytes of plain text.
 */


/**
 * The payload travels inside a JSON that escapes its own strings, and the HTML
 * escapes `&` on top of that. Without undoing all of it the URLs come out badly
 * signed and the CDN answers 403 with twelve bytes of plain text.
 */
function unescapeThreadsPayload(html) {
  return html
    .replace(/\\u003D/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\u0025/g, "%")
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u003F/g, "?")
    .replace(/\\u002F/g, "/")
    .replace(/\\u003A/g, ":")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

/**
 * A post's video, from the DASH manifest in the payload.
 *
 * Only the first `video_dash_manifest` on the page is read. Threads embeds the
 * requested post first and the related ones after, and those also bring a
 * manifest, so the first is the right one. Anchoring on the post code does not
 * work: in the payload the code and the manifest can be hundreds of kilobytes
 * apart, and the nearest block is sometimes from another post.
 */


/**
 * A post's video, from the DASH manifest in the payload.
 *
 * Only the first `video_dash_manifest` on the page is read. Threads embeds the
 * requested post first and the related ones after, and those also bring a
 * manifest, so the first is the right one. Anchoring on the post code does not
 * work: in the payload the code and the manifest can be hundreds of kilobytes
 * apart, and the nearest block is sometimes from another post.
 */
function extractThreadsVideo(html) {
  const from = html.indexOf('"video_dash_manifest":"');

  if (from < 0) return null;

  /* The manifest is long: each quality carries its signed URL, around 400
     characters, so a generous margin is taken instead of an exact cut. The
     commas are still escaped because the XML sits inside the JSON, and without
     unescaping them neither the measurements nor the quality tag can be read. */
  const slice = html.slice(from, from + 300000).replace(/\\"/g, '"');
  const renditions = [...slice.matchAll(/<Representation\s+([^>]*?)>\s*<BaseURL>([^<]{20,900})<\/BaseURL>/g)]
    .map(([, attrs, url]) => ({
      url,
      /* `\s` in front because `bandwidth` ends in "width": without it, the
         bitrate's width was being read. */
      width: Number(attrs.match(/[\s]width="(\d+)"/)?.[1] ?? 0),
      height: Number(attrs.match(/[\s]height="(\d+)"/)?.[1] ?? 0),
      label: attrs.match(/FBQualityLabel="([^"]+)"/)?.[1] ?? "",
    }))
    /* Sorted by pixels and not by tag: within one post there are several
       qualities with the same height and what tells them apart is the width. */
    .sort((a, b) => b.width * b.height - a.width * a.height);

  return renditions[0]?.url ?? null;
}

/**
 * The post's best photo. `image_versions2` brings the reductions the site uses
 * for the preview, smallest to largest. Also the first block, for the same
 * reason as the manifest.
 *
 * From a post with several photos only the first comes out: the rest arrive in
 * the carousel's children, and guessing which block of the page is which of them
 * is not reliable.
 */


/**
 * The post's best photo. `image_versions2` brings the reductions the site uses
 * for the preview, smallest to largest. Also the first block, for the same
 * reason as the manifest.
 *
 * From a post with several photos only the first comes out: the rest arrive in
 * the carousel's children, and guessing which block of the page is which of them
 * is not reliable.
 */
function extractThreadsPhoto(html) {
  const block = html.match(/"image_versions2":\{"candidates":\[(.*?)\]\}/)?.[1];

  if (!block) return null;

  const candidates = [
    ...block.matchAll(/\{"url":"(https:\/\/instagram\.fjbq1-1\.fna\.fbcdn\.net\/v\/t51\.[^"]{20,700}?)","height":(\d+),"width":(\d+)\}/g),
  ]
    .map(([, url, height, width]) => ({ url, area: Number(width) * Number(height) }))
    .sort((a, b) => b.area - a.area);

  return candidates[0]?.url ?? null;
}

/**
 * Video or photo from a Threads post.
 *
 * `/share/` links do not say which post it is: the short code is six or seven
 * binary bytes, not the identifier, but an encrypted reference. The redirection
 * is what translates it, and it happens on its own — `threads.net/share/…` gives
 * a 301 to `threads.com/share/…` and that a 302 to the real post.
 */


/**
 * Video or photo from a Threads post.
 *
 * `/share/` links do not say which post it is: the short code is six or seven
 * binary bytes, not the identifier, but an encrypted reference. The redirection
 * is what translates it, and it happens on its own — `threads.net/share/…` gives
 * a 301 to `threads.com/share/…` and that a 302 to the real post.
 */
async function fetchThreadsMedia(source) {
  const code = extractThreadsCode(source);

  if (!code) throw explain("That Threads link is not a post");

  /* For the direct link the URL is honoured as-is minus the query, because the
     post goes by user and Threads does not resolve an `@anyone`. For the
     `/share/` one it goes via threads.net, which is what does the first
     redirection. */
  const esCompartido = /\/share\//i.test(String(source));
  const targetUrl = esCompartido
    ? `https://www.threads.net/share/${code}`
    : String(source).trim().split(/[?#]/)[0];

  const page = await fetchPage(targetUrl, THREADS_NAV_HEADERS, 0, 3_000_000);

  if (!page.ok) throw withStatus(new Error(`Threads responded ${page.status}`), page.status);

  const html = unescapeThreadsPayload(page.text);
  const video = extractThreadsVideo(html);
  const foto = extractThreadsPhoto(html);

  if (video) return [{ media: [video], isVideo: true, kind: "video" }];
  if (foto) return [{ media: [foto], isVideo: false, kind: "image" }];

  /* The shell is about 277 KB and the post about 900 KB, so the size says which
     of the two came back, and with it whether the fault is Threads' or the
     post's.

     It uses `explain()` and not `throw`: in both branches it is the link's
     fault —a deleted or private post, or an account that does not exist— and a
     500 not only lies but also inflates the Worker's error stats. */
  throw explain(
    page.text.length < 500000
      ? "Threads returned no content for that post; it is probably private or deleted"
      : "That Threads post has no downloadable video or photos",
  );
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectThreads(source) {
  const code = extractThreadsCode(source);
  if (!code) return null;

  return {
    files: await fetchThreadsMedia(source),
    prefix: `threads-${code}`,
    referer: "https://www.threads.com/",
  };
}
