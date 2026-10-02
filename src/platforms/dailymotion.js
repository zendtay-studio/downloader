/* Dailymotion. Everything that knows about this one site lives here and
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


/** Dailymotion video: /video/x9l9zoo, dai.ly/x9l9zoo or /embed/video/x9l9zoo. */
function extractDailymotionId(value) {
  const text = String(value ?? "");

  return text.match(/(?:dailymotion\.com|dai\.ly)\/(?:video|embed\/video|swf\/video)\/([a-z0-9]{6,})/i)?.[1]
    ?? text.match(/(?:dailymotion\.com|dai\.ly)\/([a-z0-9]{6,})(?:[/?#]|$)/i)?.[1]
    ?? null;
}

/**
 * Dailymotion does not publish mp4: only signed HLS. The player metadata, which
 * is public, is read and the playlist is handed over for the server to wrap.
 */


/**
 * Dailymotion does not publish mp4: only signed HLS. The player metadata, which
 * is public, is read and the playlist is handed over for the server to wrap.
 */
async function fetchDailymotionMedia(videoId) {
  const page = await fetchPage(`https://www.dailymotion.com/player/metadata/video/${encodeURIComponent(videoId)}`, {
    "User-Agent": SAFARI_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.dailymotion.com/",
  });

  if (!page.ok) throw explain("That Dailymotion video does not exist");

  let meta = null;

  try {
    meta = JSON.parse(page.text);
  } catch {}

  if (!meta) throw explain("That Dailymotion video could not be read");

  const files = [];
  const playlist = (meta.qualities?.auto ?? []).find((entry) => /\.m3u8/i.test(entry.url ?? ""));

  if (playlist?.url) {
    files.push({ media: [playlist.url], isVideo: true, kind: "video", extension: "ts", hls: true });
  }

  const sizes = Object.keys(meta.thumbnails ?? {}).sort((a, b) => Number(b) - Number(a));
  const poster = sizes.length ? meta.thumbnails[sizes[0]] : null;

  if (poster) files.push({ media: [poster], isVideo: false, kind: "image" });

  if (!files.length) throw explain("That Dailymotion video has no downloadable file");

  return files;
}

/**
 * Kwai and its Chinese version Kuaishou. Every known shape is accepted:
 *   /@user/video/<id> · /@user/photo/<id> · /f/<id> · /fw/photo/<id>
 *   /short-video/<id> (Kuaishou) · short links v.kwai.com/abc (no id)
 * The host is checked first so video ids from another platform are not read.
 */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectDailymotion(source) {
  const id = extractDailymotionId(source);
  if (!id) return null;

  return {
    files: await fetchDailymotionMedia(id),
    prefix: `dailymotion-${id}`,
    referer: "https://www.dailymotion.com/",
  };
}
