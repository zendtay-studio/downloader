/* Kwai. Everything that knows about this one site lives here and
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
  platformOf,
} from "../core.mjs";


/**
 * Kwai and its Chinese version Kuaishou. Every known shape is accepted:
 *   /@user/video/<id> · /@user/photo/<id> · /f/<id> · /fw/photo/<id>
 *   /short-video/<id> (Kuaishou) · short links v.kwai.com/abc (no id)
 * The host is checked first so video ids from another platform are not read.
 */
function extractKwaiRef(value) {
  const text = String(value ?? "");

  if (platformOf(text) !== "kwai") return null;

  return {
    id: text.match(/\/(?:video|photo|short-video|f|fw\/photo)\/(\d{8,24})(?:[/?#]|$)/i)?.[1]
      ?? text.match(/[?&](?:photoId|photo_id|id)=(\d{8,24})/i)?.[1]
      ?? null,
  };
}


const KWAI_LD = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** JSON-LD nodes of the page, tolerating lists and @graph. */


/** JSON-LD nodes of the page, tolerating lists and @graph. */
function kwaiNodes(html) {
  const out = [];

  for (const match of html.matchAll(KWAI_LD)) {
    try {
      const parsed = JSON.parse(match[1].trim());

      for (const node of Array.isArray(parsed) ? parsed : parsed?.["@graph"] ?? [parsed]) {
        if (node && typeof node === "object") out.push(node);
      }
    } catch {}
  }

  return out;
}

/**
 * Kwai publishes the file in a JSON-LD `VideoObject` on the post page, and it
 * works the same across every domain and short link: just follow the redirect
 * and keep the node whose URL is the same page that was reached. That way a
 * profile —which is not a post— gives a clear error instead of silently
 * returning the featured video.
 */


/**
 * Kwai publishes the file in a JSON-LD `VideoObject` on the post page, and it
 * works the same across every domain and short link: just follow the redirect
 * and keep the node whose URL is the same page that was reached. That way a
 * profile —which is not a post— gives a clear error instead of silently
 * returning the featured video.
 */
async function fetchKwaiMedia(url, expectedId) {
  const page = await fetchPage(url, {
    "User-Agent": MOBILE_USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
  });

  if (!page.ok) throw withStatus(new Error(`Kwai responded ${page.status}`), page.status);

  const clean = (value) => String(value ?? "").split(/[?#]/)[0].replace(/\/+$/, "");
  const landed = clean(page.url || url);
  const video = kwaiNodes(page.text).find((node) => {
    if (node["@type"] !== "VideoObject" || !node.contentUrl) return false;

    const own = clean(node.url || node["@id"]);

    return own === landed || (expectedId && own.includes(`/${expectedId}`));
  });

  if (!video) throw explain("That Kwai link does not point to a public post");

  return [{ media: [video.contentUrl], isVideo: true, kind: "video", extension: "mp4" }];
}

/**
 * Spotify: /track/<id>, /album/<id>, /playlist/<id>, /artist/<id> and podcasts,
 * with or without a language prefix (/intl-es/…). The `spotify:track:<id>` URI
 * and spotify.link short links also work, the latter by following the redirect.
 */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectKwai(source) {
  const ref = extractKwaiRef(source);
  if (!ref) return null;

  return {
    files: await fetchKwaiMedia(source, ref.id),
    prefix: `kwai-${ref.id ?? "post"}`,
    referer: "https://www.kwai.com/",
  };
}
