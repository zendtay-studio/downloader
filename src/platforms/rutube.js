/* Rutube. Everything that knows about this one site lives here and nowhere else:
 * the link patterns, the requests, and how its answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a relative import:
 * `tools/build.mjs` strips it when it flattens every file into the single Worker,
 * and there it is already in scope. */
import {
  DESKTOP_USER_AGENT,
  explain,
  fetchPage,
  fetchTimed,
  bestVariant,
} from "../core.mjs";

/**
 * Rutube ids out of a link.
 *
 * An id is exactly 32 hex characters, which is what makes it the easiest pattern in
 * this project to get right: `comId` in another extractor has a length *limit*, and
 * this one has a length to match. The surrounding shapes —`/video/<id>/`,
 * `/play/embed/<id>`, `/shorts/<id>`— are all read by the same expression, and the
 * private form `/video/private/<id>?p=<key>` keeps its key out of the result because
 * the public endpoints do not want it.
 */
function extractRutubeId(value) {
  const text = String(value ?? "");

  return text.match(/rutube\.ru\/(?:video\/(?:private\/)?|play\/embed\/|shorts\/|yappy\/)([a-f0-9]{32})(?:[/?#]|$)/i)?.[1]
    ?? null;
}

/**
 * Videos from a Rutube id.
 *
 * There are two APIs and they answer different questions. `/api/video/<id>/` gives
 * the metadata —title, author, duration, poster— but nothing playable: its
 * `video_url` is the page itself, not a file. The address of the stream is only in
 * `/api/play/options/<id>/`, which is what the site's own player asks for and what
 * carries the balancer.
 *
 * That balancer URL is signed and it expires, so the playlist is read here rather
 * than handed over to be fetched later: a link resolved and downloaded an hour later
 * would come back 403, and the failure would look like the video had gone away.
 */
async function fetchRutubeMedia(videoId) {
  const base = { "User-Agent": DESKTOP_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" };
  const referer = `https://rutube.ru/video/${videoId}/`;

  const options = await fetchPage(`https://rutube.ru/api/play/options/${encodeURIComponent(videoId)}/`, {
    ...base,
    Accept: "application/json",
    Referer: referer,
  });

  if (!options.ok) {
    if (options.status === 404) throw explain("That Rutube video does not exist");

    throw explain(`Rutube responded ${options.status}`);
  }

  let meta = null;

  try {
    meta = JSON.parse(options.text);
  } catch {}

  if (!meta) throw explain("That Rutube video could not be read");

  /* `has_video` is false for the audio-only posts, which Rutube also hosts, and for
     anything blocked. Either way there is no video track to give. */
  if (meta.has_video === false) {
    throw explain("That Rutube post has no video, only audio");
  }

  const master = meta.video_balancer?.default;

  if (!master) throw explain("That Rutube video has no downloadable file");

  const playlist = await fetchTimed(master, {
    headers: { "User-Agent": DESKTOP_USER_AGENT, Referer: "https://rutube.ru/" },
  });

  if (!playlist.ok) throw explain("That Rutube video's playlist could not be read");

  const variant = bestVariant(await playlist.text());

  if (!variant) throw explain("That Rutube video has no downloadable file");

  /* The master lists absolute URLs, but resolving them against the master anyway
     costs nothing and covers the case where one comes back relative. */
  const files = [{
    media: [new URL(variant, master).href],
    isVideo: true,
    kind: "video",
    extension: "ts",
    hls: true,
  }];

  const cover = meta.thumbnail_url;

  if (cover) files.push({ media: [cover], isVideo: false, kind: "image" });

  return files;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the dispatcher
 * move on to the next platform. Everything else throws, with a message meant for
 * whoever pasted the link.
 */
export async function detectRutube(source) {
  const id = extractRutubeId(source);

  if (!id) return null;

  return {
    files: await fetchRutubeMedia(id),
    prefix: `rutube-${id.slice(0, 8)}`,
    referer: "https://rutube.ru/",
  };
}