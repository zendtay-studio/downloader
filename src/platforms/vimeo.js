/* Vimeo. Everything that knows about this one site lives here and nowhere else:
 * the link patterns, the requests, and how its answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a relative
 * import: `tools/build.mjs` strips it when it flattens every file into the single
 * Worker, and there it is already in scope. */
import {
  DESKTOP_USER_AGENT,
  explain,
  fetchPage,
  fetchTimed,
  bestVariant,
} from "../core.mjs";

/**
 * Vimeo ids out of a link.
 *
 * Vimeo has more shapes than it looks: `vimeo.com/12345`, `player.vimeo.com/video/12345`,
 * the private-link form with a hash (`/12345/abcdef1234`) and the showcase form with
 * a slug (`/channels/staffpicks/12345/a-name`). They all end in the same digits, so
 * one pattern reads them all and the hash is dropped: the config endpoint does not
 * want it and refuses URLs that carry one.
 *
 * `player.vimeo.com/video/...` is a subdomain and `/video/` is in the path, which is
 * why the player form is matched first — otherwise the digits after `/video/` in the
 * plain form could be read as the id.
 */
function extractVimeoId(value) {
  const text = String(value ?? "");

  return text.match(/player\.vimeo\.com\/video\/(\d{6,})/i)?.[1]
    ?? text.match(/vimeo\.com\/(?:video\/|channels\/[^/?#]+\/|groups\/[^/?#]+\/videos\/|ondemand\/[^/?#]+\/)?(\d{6,})/i)?.[1]
    ?? null;
}

/**
 * Videos from a Vimeo page.
 *
 * The player config is the whole of it: it answers with the duration, the title and
 * the file list, without the page having to be read at all. Progressive MP4s are
 * preferred when there are any, because they are a single file; a video that only
 * offers HLS is still given, as a playlist, which is the same thing Dailymotion
 * returns and the same thing the API knows how to play.
 */
async function fetchVimeoMedia(videoId) {
  const config = await fetchPage(`https://player.vimeo.com/video/${encodeURIComponent(videoId)}/config`, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://player.vimeo.com/",
  });

  if (!config.ok) {
    if (config.status === 403 || config.status === 404) {
      throw explain("That Vimeo video does not exist, or it is private");
    }

    throw explain(`Vimeo responded ${config.status}`);
  }

  let meta = null;

  try {
    meta = JSON.parse(config.text);
  } catch {}

  const metaFiles = meta?.request?.files ?? {};

  if (!meta?.request) throw explain("That Vimeo video could not be read");

  const files = [];
  const progressive = (metaFiles.progressive ?? [])
    .filter((rung) => typeof rung.url === "string" && rung.url.startsWith("http"))
    /* The biggest progressive file, by pixel count. They are listed largest first
       in practice, and comparing is cheaper than trusting that. */
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

  if (progressive.length) {
    files.push({
      media: [progressive[0].url],
      isVideo: true,
      kind: "video",
      extension: "mp4",
      label: `${progressive[0].width}x${progressive[0].height}`,
    });
  } else {
    /* No MP4. The HLS CDN URLs are relative paths built with `exp=` and `acl=`
       signatures that expire, so the playlist is read now rather than handed over
       to be fetched later: a link that is read in an hour would come back 403. */
    const cdn = Object.values(metaFiles.hls?.cdns ?? {})[0];
    const manifest = cdn?.avc_url;

    if (!manifest) throw explain("That Vimeo video has no downloadable file");

    const playlist = await fetchTimed(manifest, {
      headers: {
        "User-Agent": DESKTOP_USER_AGENT,
        Referer: "https://player.vimeo.com/",
      },
    });

    if (!playlist.ok) throw explain("That Vimeo video's playlist could not be read");

    const variant = bestVariant(await playlist.text());

    if (!variant) throw explain("That Vimeo video has no downloadable file");

    /* The variant URL is relative to the master it came from, so it is resolved
       here. Handing over a relative path would make the browser ask its own
       origin for it. */
    files.push({
      media: [new URL(variant, manifest).href],
      isVideo: true,
      kind: "video",
      extension: "ts",
      hls: true,
    });
  }

  const cover = meta?.video?.thumbnail;

  if (cover) files.push({ media: [cover], isVideo: false, kind: "image" });

  if (!files.length) throw explain("That Vimeo video has no downloadable file");

  return files;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the dispatcher
 * move on to the next platform. Everything else throws, with a message meant for
 * whoever pasted the link.
 */
export async function detectVimeo(source) {
  const id = extractVimeoId(source);

  if (!id) return null;

  return {
    files: await fetchVimeoMedia(id),
    prefix: `vimeo-${id}`,
    referer: "https://vimeo.com/",
  };
}