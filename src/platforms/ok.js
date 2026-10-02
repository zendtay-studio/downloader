/* Ok. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  SAFARI_USER_AGENT,
  explain,
  fetchPage,
} from "../core.mjs";


/** OK (Odnoklassniki) video: /video/123 or /videoembed/123. */
function extractOkId(value) {
  return String(value ?? "").match(/(?:ok\.ru|odnoklassniki\.[a-z.]+)\/(?:video|videoembed|videoPlayer)\/(\d{6,})/i)?.[1] ?? null;
}

/** Pulls the "metadata" JSON object that OK leaves inside its data. */
function pickOkMetadata(html) {
  const at = html.indexOf("\"metadata\":");

  if (at < 0) return null;

  const start = html.indexOf("{", at);

  if (start < 0) return null;

  let depth = 0;

  for (let i = start; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;

      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/** OK delivers the video in signed variants; the largest is the best quality. */


/** OK delivers the video in signed variants; the largest is the best quality. */
async function fetchOkMedia(videoId) {
  const page = await fetchPage(`https://ok.ru/videoembed/${encodeURIComponent(videoId)}`, {
    "User-Agent": SAFARI_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://ok.ru/",
  });

  if (!page.ok) throw explain("That OK video does not exist or is private");

  const html = page.text
    .replace(/\\u0026/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/\\\//g, "/");
  const meta = pickOkMetadata(html);
  const rank = { full: 6, hd: 5, sd: 4, low: 3, lowest: 2, mobile: 1 };
  const videos = (meta?.videos ?? [])
    .filter((entry) => typeof entry.url === "string" && entry.url.startsWith("http"))
    .sort((a, b) => (rank[String(b.name)] ?? 0) - (rank[String(a.name)] ?? 0))
    .map((entry) => entry.url);

  if (!videos.length) throw explain("That OK video has no downloadable file");

  const files = [{ media: videos, isVideo: true, kind: "video", extension: "mp4" }];
  const poster = meta?.movie?.poster;

  if (poster) files.push({ media: [poster], isVideo: false, kind: "image" });

  return files;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectOk(source) {
  const id = extractOkId(source);
  if (!id) return null;

  return {
    files: await fetchOkMedia(id),
    prefix: `ok-${id}`,
    referer: "https://ok.ru/",
  };
}
