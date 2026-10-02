/* Reddit. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  DESKTOP_USER_AGENT,
  MOBILE_USER_AGENT,
  withStatus,
  explain,
  fetchPage,
  platformOf,
} from "../core.mjs";


/**
 * Reddit. Links shared by the app are /r/<sub>/s/<code>, which redirect to the
 * real post; /r/<sub>/comments/<id>/<slug>/, /user/<u>/comments/… and the short
 * old/new domains work too.
 *
 * The `.json` API is closed to datacenter IPs (403), but the embed does serve the
 * post's data: that is where the signed photo URLs come from and, for videos,
 * the HLS playlist.
 */
function extractRedditRef(value) {
  const text = String(value ?? "");

  if (platformOf(text) !== "reddit") return null;

  return { share: /\/r\/[^/]+\/s\/[A-Za-z0-9]+/.test(text) };
}


const REDDIT_MEDIA = /https:\/\/(?:preview|i)\.redd\.it\/[^"'<\\\s]{10,220}/g;

/**
 * Reddit serves images already signed: the `s=` signature is bound to the
 * parameters, so they cannot be touched (changing the width gives 403). Only the
 * largest variant of each photo is kept, without duplicates.
 */


/**
 * Reddit serves images already signed: the `s=` signature is bound to the
 * parameters, so they cannot be touched (changing the width gives 403). Only the
 * largest variant of each photo is kept, without duplicates.
 */
function redditPhotos(html) {
  const best = new Map();

  for (const raw of html.match(REDDIT_MEDIA) ?? []) {
    const url = raw.replace(/&amp;/g, "&");
    // The same photo appears at 320, 640 and 1080: identity is the path, the
    // parameters only pick the size. The largest is kept, in the order they
    // appear, which is the album's order.
    const [path, query] = url.split("?");
    const width = Number(/(?:^|&)width=(\d+)/.exec(query ?? "")?.[1] ?? 0);
    const seen = best.get(path);

    if (!seen || width > seen.width) best.set(path, { width, url });
  }

  return [...best.values()].map((entry) => ({
    media: [entry.url],
    isVideo: false,
    kind: "image",
    extension: "jpg",
  }));
}

/**
 * From Reddit's master playlist, the best image and the audio that image declares
 * are picked: the video and the sound are in separate lists.
 */


/**
 * From Reddit's master playlist, the best image and the audio that image declares
 * are picked: the video and the sound are in separate lists.
 */
async function redditRenditions(masterUrl) {
  const page = await fetchPage(masterUrl, { "User-Agent": MOBILE_USER_AGENT });
  const lines = page.ok ? page.text.split("\n").map((line) => line.trim()) : [];
  const tracks = new Map();
  let video = null;
  let bestHeight = -1;
  let wanted = "";

  for (const [index, line] of lines.entries()) {
    if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line)) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      const group = /GROUP-ID="([^"]+)"/.exec(line)?.[1] ?? "";

      if (uri) tracks.set(group, { uri, bitrate: Number(/AUDIO_(\d+)/.exec(uri)?.[1] ?? 0) });
      continue;
    }

    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const height = Number(/RESOLUTION=\d+x(\d+)/.exec(line)?.[1] ?? 0);
    const target = lines.slice(index + 1).find((value) => value && !value.startsWith("#"));

    if (!target || height <= bestHeight) continue;

    bestHeight = height;
    video = new URL(target, masterUrl).href;
    wanted = /AUDIO="([^"]+)"/.exec(line)?.[1] ?? "";
  }

  const soundtrack = tracks.get(wanted)
    ?? [...tracks.values()].sort((a, b) => b.bitrate - a.bitrate)[0];

  return { video, audio: soundtrack ? new URL(soundtrack.uri, masterUrl).href : null };
}


async function fetchRedditMedia(url) {
  const landing = await fetchPage(url, { "User-Agent": DESKTOP_USER_AGENT });
  const post = (landing.url ?? url).match(/reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);

  if (!post) throw explain("That Reddit link does not point to a post");

  const [, sub, id] = post;
  const page = await fetchPage(`https://embed.reddit.com/r/${sub}/comments/${id}/`, {
    "User-Agent": DESKTOP_USER_AGENT,
  });

  if (!page.ok) throw withStatus(new Error(`Reddit responded ${page.status}`), page.status);

  const html = page.text;
  const master = html.replace(/&amp;/g, "&").match(/https:\/\/v\.redd\.it\/[^"'<\\\s]*HLSPlaylist\.m3u8[^"'<\\\s]*/)?.[0];
  const photos = redditPhotos(html);

  if (master) {
    const { video, audio } = await redditRenditions(master);

    if (!video) throw explain("That Reddit video has no downloads available");

    // Reddit splits image and sound into two lists: they are delivered together,
    // each as a complete file, because merging them here is not a TS remux.
    const files = [{ media: [video], hls: true, fmp4: true, isVideo: true, kind: "video", extension: "mp4" }];

    if (audio) files.push({ media: [audio], hls: true, fmp4: true, isVideo: false, kind: "audio", extension: "m4a" });

    return files;
  }

  if (photos.length) return photos;

  throw explain("That Reddit post has no downloadable photos or video");
}

/** Bluesky post: /profile/<handle>/post/<rkey>. */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectReddit(source) {
  const ref = extractRedditRef(source);
  if (!ref) return null;

  return {
    files: await fetchRedditMedia(source),
    prefix: "reddit",
    referer: "https://www.reddit.com/",
  };
}
