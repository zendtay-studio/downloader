/* Streamable. Everything that knows about this one site lives here and nowhere
 * else: the link patterns, the requests, and how its answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a relative
 * import: `tools/build.mjs` strips it when it flattens every file into the single
 * Worker, and there it is already in scope. */
import {
  DESKTOP_USER_AGENT,
  explain,
  fetchPage,
} from "../core.mjs";

/**
 * Streamable ids out of a link.
 *
 * A Streamable id is five or six characters and can be letters and digits, so it
 * is matched by length rather than by shape: there is no fixed alphabet to lean on
 * and the ids in the wild are everything from `hn8hq` to `o0e0e`. The four
 * single-letter prefixes (`/o/`, `/e/`, `/s/`, `/t/`) are how the site itself
 * shortens links, and they are peeled off before the id is read so all of them end
 * up as the same five characters the API expects.
 */
function extractStreamableId(value) {
  const text = String(value ?? "");

  return text.match(/streamable\.com\/(?:[oest]\/)?([A-Za-z0-9]{5,6})(?:[/?#]|$)/i)?.[1]
    ?? null;
}

/**
 * Videos from a Streamable id.
 *
 * The API is public and needs no key: the id is enough. It answers with one entry
 * per rendition, and the sizes are named rather than numbered —`mp4` is the
 * desktop file, `mp4-mobile` the small one, and `original` the upload as it came
 * in, which is the only one that may not be an MP4 at all.
 *
 * The desktop `mp4` is preferred and `original` is the last resort rather than the
 * first: an `original` can be a `.mov` or a `.webm` renamed by whoever uploaded
 * it, and the browser plays the two MP4 renditions without being told anything.
 */
async function fetchStreamableMedia(videoId) {
  const page = await fetchPage(`https://api.streamable.com/videos/${encodeURIComponent(videoId)}`, {
    "User-Agent": DESKTOP_USER_AGENT,
    Accept: "application/json",
  });

  if (page.status === 404) throw explain("That Streamable video does not exist");

  if (!page.ok) throw explain(`Streamable responded ${page.status}`);

  let meta = null;

  try {
    meta = JSON.parse(page.text);
  } catch {}

  /* `status` is the processing state: 1 means still uploading, 2 means ready. A
     video that is still going up has no playable rendition yet, and answering with
     it would produce a download that fails halfway. */
  if (!meta || meta.status !== 2) {
    throw explain("That Streamable video is still processing, or it is not public");
  }

  const files = meta.files ?? {};
  const chosen = files.mp4 ?? files["mp4-mobile"] ?? files.original;

  if (!chosen?.url) throw explain("That Streamable video has no downloadable file");

  const output = [{
    media: [chosen.url.startsWith("//") ? `https:${chosen.url}` : chosen.url],
    isVideo: true,
    kind: "video",
    extension: /\.mp4$/i.test(chosen.url) ? "mp4" : "mp4",
    label: chosen.width && chosen.height ? `${chosen.width}x${chosen.height}` : null,
  }];

  const cover = meta.thumbnail_url;

  if (cover) {
    output.push({
      media: [cover.startsWith("//") ? `https:${cover}` : cover],
      isVideo: false,
      kind: "image",
    });
  }

  return output;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the dispatcher
 * move on to the next platform. Everything else throws, with a message meant for
 * whoever pasted the link.
 */
export async function detectStreamable(source) {
  const id = extractStreamableId(source);

  if (!id) return null;

  return {
    files: await fetchStreamableMedia(id),
    prefix: `streamable-${id}`,
    referer: "https://streamable.com/",
  };
}