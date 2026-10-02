/* Bluesky. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  explain,
  fetchTimed,
} from "../core.mjs";


/** Bluesky post: /profile/<handle>/post/<rkey>. */
function extractBskyRef(value) {
  const match = String(value ?? "").match(
    /(?:bsky\.app|bsky\.social)\/profile\/([^/?#]+)\/post\/([a-z0-9]+)/i,
  );

  return match ? { handle: match[1], rkey: match[2] } : null;
}

/**
 * Bluesky has a public API needing no account: the handle is resolved to a DID
 * and the post is requested. Photos come off the CDN and the video arrives as
 * HLS.
 */


/**
 * Bluesky has a public API needing no account: the handle is resolved to a DID
 * and the post is requested. Photos come off the CDN and the video arrives as
 * HLS.
 */
async function fetchBskyMedia(handle, rkey) {
  const api = "https://public.api.bsky.app/xrpc";
  // The AppView sometimes fails to resolve handles: the user's PDS always
  // answers, so both are tried.
  let did = null;

  for (const base of [api, "https://bsky.social/xrpc"]) {
    try {
      const resolved = await fetchTimed(
        `${base}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      );

      if (!resolved.ok) continue;

      did = (await resolved.json())?.did ?? null;

      if (did) break;
    } catch {}
  }

  if (!did) throw explain("That Bluesky profile does not exist");

  const atUri = `at://${did}/app.bsky.feed.post/${rkey}`;
  const thread = await fetchTimed(`${api}/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`);

  if (!thread.ok) throw explain("That Bluesky post does not exist or is private");

  const payload = await thread.json();
  const post = payload?.posts?.[0];
  const embed = post?.embed;

  if (!embed) throw explain("That Bluesky post has no video or photos");

  const files = [];

  if (String(embed.$type).startsWith("app.bsky.embed.images")) {
    const images = (embed.images ?? [])
      .map((image) => image.fullsize ?? image.thumb)
      .filter((url) => typeof url === "string" && url.startsWith("http"));

    if (!images.length) throw explain("That post has no downloadable photos");

    images.forEach((url) => files.push({ media: [url], isVideo: false, kind: "image" }));
    return files;
  }

  if (String(embed.$type).startsWith("app.bsky.embed.video")) {
    if (!embed.playlist) throw explain("That Bluesky video is not available");

    files.push({ media: [embed.playlist], isVideo: true, kind: "video", extension: "ts", hls: true });

    if (embed.thumbnail) files.push({ media: [embed.thumbnail], isVideo: false, kind: "image" });
    return files;
  }

  throw explain("That Bluesky post only links to other content");
}

/** OK (Odnoklassniki) video: /video/123 or /videoembed/123. */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectBluesky(source) {
  const ref = extractBskyRef(source);
  if (!ref) return null;

  return {
    files: await fetchBskyMedia(ref.handle, ref.rkey),
    prefix: `bluesky-${ref.rkey}`,
    referer: "https://bsky.app/",
  };
}
