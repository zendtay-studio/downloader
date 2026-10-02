/* X. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  MOBILE_USER_AGENT,
  withStatus,
  explain,
  fetchPage,
} from "../core.mjs";


function extractXStatus(value) {
  const text = String(value ?? "");

  return text.match(/(?:x|twitter)\.com\/(?:[A-Za-z0-9_]+\/status|i\/status)\/(\d{15,25})/i)?.[1]
    ?? text.match(/(?:fxtwitter|vxtwitter)\.com\/[A-Za-z0-9_]+\/status\/(\d{15,25})/i)?.[1]
    ?? null;
}

/**
 * The syndication token is derived from the status id; with it X returns the
 * tweet's public JSON with no account and no guest API.
 */


/**
 * The syndication token is derived from the status id; with it X returns the
 * tweet's public JSON with no account and no guest API.
 */
function xSyndicationToken(statusId) {
  return ((Number(statusId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** Videos and photos from an X status. */


/** Videos and photos from an X status. */
async function fetchXMedia(statusId) {
  const token = xSyndicationToken(statusId);
  const page = await fetchPage(`https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&lang=es&token=${encodeURIComponent(token)}`, {
    "User-Agent": MOBILE_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `https://x.com/i/status/${statusId}`,
  });

  if (!page.ok) throw explain("That X post does not exist or is private");

  let payload = null;

  try {
    payload = JSON.parse(page.text);
  } catch {}

  const details = Array.isArray(payload?.mediaDetails) ? payload.mediaDetails : [];
  const files = [];

  for (const media of details) {
    if (media.type === "video") {
      const variants = (media.video_info?.variants ?? [])
        .filter((variant) => variant.content_type === "video/mp4" && variant.url)
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        .map((variant) => variant.url);

      if (variants.length) files.push({ media: variants, isVideo: true, kind: "video", extension: "mp4" });

      const poster = media.media_url_https ?? payload?.video?.poster;

      if (poster) files.push({ media: [poster], isVideo: false, kind: "image" });
      continue;
    }

    if (media.type === "photo" && media.media_url_https) {
      files.push({ media: [`${media.media_url_https}?name=orig`], isVideo: false, kind: "image" });
    }
  }

  if (!files.length) throw explain("That X post has no video or photos");

  return files;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectX(source) {
  const status = extractXStatus(source);
  if (!status) return null;

  return {
    files: await fetchXMedia(status),
    prefix: `x-${status}`,
    referer: "https://x.com/",
  };
}
