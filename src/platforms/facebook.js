/* Facebook. Everything that knows about this one site lives here and
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
  cookieJar,
  cookieValue,
  explain,
  fetchPage,
  platformOf,
} from "../core.mjs";


/**
 * Facebook: the reel's og tags carry the MP4 and the cover, and the CDN sends
 * CORS, so the video downloads straight from the browser.
 */
async function fetchFacebookMedia(videoId, sourceUrl) {
  const page = (target) => target.replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/&quot;/g, "\"");
  const sources = [
    `https://www.facebook.com/reel/${videoId}`,
    `https://m.facebook.com/reel/${videoId}`,
    `https://mbasic.facebook.com/reel/${videoId}`,
    `https://www.facebook.com/watch/?v=${videoId}`,
    // A reel and a page video are the same object under the same id, and Facebook
    // does not always serve the one from the other: `/reel/<id>` is tried first and
    // `/videos/<id>` is here so a page video has a way out when the reel form of it
    // is a 404. The parser accepts both, so the fallback had to as well.
    `https://www.facebook.com/videos/${videoId}/`,
    // The link as it was pasted is worth a try of its own, and the check has to
    // allow a page name in front: `facebook.com/<page>/videos/...` is a page
    // video and it used to be left out of the candidates for that reason.
    /* This one is the dangerous half. The link as it was pasted is fetched WITH
       the cookie jar attached, so anything that reaches this line decides where
       `FB_COOKIE` is sent. `platformOf` — not a pattern over the string — is what
       keeps that to Facebook. */
    ...(sourceUrl && platformOf(sourceUrl) === "facebook" ? [sourceUrl] : []),
    `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(`https://www.facebook.com/reel/${videoId}`)}`,
  ];
  const agents = [MOBILE_USER_AGENT, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1", DESKTOP_USER_AGENT];
  const jar = cookieJar(cookieValue("FB_COOKIE"));
  const videos = [];
  const posters = [];

  for (const url of sources) {
    for (const agent of agents) {
      if (videos.length) break;

      const found = await fetchPage(url, {
        "User-Agent": agent,
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.facebook.com/",
        ...(jar.header() ? { Cookie: jar.header() } : {}),
      });

      jar.absorb(found.headers);

      if (!found.ok) continue;

      const html = found.text;

      for (const match of html.matchAll(/<meta[^>]+property="og:(?:video:secure_url|video:url|video)"[^>]+content="([^"]+)"/gi)) {
        videos.push(page(match[1]));
      }

      for (const match of html.matchAll(/"(?:playable_url|sd_src|hd_src)"\s*:\s*"(https:[^"]+)"/g)) {
        videos.push(page(match[1]));
      }

      for (const match of html.matchAll(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/gi)) {
        posters.push(page(match[1]));
      }
    }
  }

  const video = [...new Set(videos)];
  const poster = [...new Set(posters)];

  if (!video.length && !poster.length) {
    throw explain("That Facebook reel is not available without signing in");
  }

  const files = [];

  if (video.length) files.push({ media: video, isVideo: true, kind: "video", extension: "mp4" });
  if (poster.length) files.push({ media: poster, isVideo: false, kind: "image" });

  return files;
}

/* The secrets arrive through the Worker's handler, which is the only thing that
   sees them: in a Worker `env` is passed as the second argument of `fetch` and
   there is no `process.env` to look at — `wrangler.toml` goes without
   `nodejs_compat` on purpose.

   They used to be read only from there, and that works in Node but in the Worker
   it does not, without any warning: all seven secrets could be set with
   `wrangler secret put` and did nothing. The failure was invisible precisely
   because the wording of "there is no cookie" and of "the cookie is not set"
   give the same result.

   It is module state and not a parameter to pass along the whole chain because
   the isolate is reused: `env` is the same on every request, so reassigning it
   on each one is idempotent and no value from another can be left behind. */


/**
 * Facebook ids out of a link: /reel/123, /videos/123, /watch/?v=123, fb.watch/abc,
 * and a page video.
 *
 * A page video is the one that was missing. It carries the page and a slug before
 * the id — `facebook.com/<page>/videos/<slug>/<id>/` — so the pattern that looks
 * for `facebook.com/videos/` never matched it, and the id-less link fell through
 * to the universal extractor as if Facebook were not a platform at all. The id is
 * the last run of digits under `/videos/`, whatever sits in between.
 */
export function extractFacebookId(value) {
  const text = String(value ?? "");

  /* The host decides, before the pattern does. The patterns below all look for
     `facebook.com/` somewhere in the string, and a string is not a host: a link
     like `https://anything.example/facebook.com/reel/123456789` contains that
     text and satisfied all of them.

     That was not a cosmetic gap. `dispatch` tries every extractor against every
     link whose host it does not recognise, so a link on someone else's domain
     was read as a Facebook reel — and this extractor's candidates include the
     link as it was pasted, fetched with `FB_COOKIE` attached. A Facebook session
     cookie handed to a host the person pasting the link chose is account
     takeover, not a wrong answer.

     `platformOf` is the same gate kwai, reddit, soundcloud and spotify already
     use, and it reads `PLATFORM_HOSTS`, which is anchored to a host. */
  if (platformOf(text) !== "facebook") return null;

  return text.match(/facebook\.com\/(?:reel|videos|watch\/live|posts)\/(\d{6,})/i)?.[1]
    // Page video: the page name and a slug come between the host and the id.
    ?? text.match(/facebook\.com\/[^/?#]+\/videos\/(?:[^/?#]+\/)*?(\d{6,})/i)?.[1]
    // The bare `?v=` form only counts when the host is Facebook. Without the
    // host it matched any link carrying a numeric `v` parameter — including a
    // YouTube video whose id happens to be all digits, like `watch?v=12345678901`
    // — and Facebook is tried before YouTube, so that link was read as a
    // Facebook reel and failed there instead of resolving.
    ?? (/(?:^|\/\/|\.)(?:www\.|web\.|m\.)?facebook\.com(?:$|\/)/i.test(text)
      ? text.match(/[?&]v=(\d{6,})/i)?.[1]
      : undefined)
    ?? text.match(/(?:fb\.watch|fb\.com\/share\/v)\/([A-Za-z0-9_-]{6,})/i)?.[1]
    ?? null;
}

/**
 * Snapchat serves the media on the page itself, no account needed: Spotlight
 * posts carry their mp4 in og:video and highlights carry the list of photos and
 * videos in the snapList block. The type of each item is checked with a Range
 * because the URL does not say.
 */
/**
 * Snapchat reference out of a link: `snapchat.com/@user/{spotlight|highlight}/id`.
 * The kind is part of the path because the same id means different things: a
 * Spotlight is one video, a highlight is a list of photos and videos.
 */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectFacebook(source) {
  const id = extractFacebookId(source);
  if (!id) return null;

  return {
    files: await fetchFacebookMedia(id, source),
    prefix: `facebook-${id}`,
    referer: "https://www.facebook.com/",
  };
}
