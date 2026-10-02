/* Snapchat. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  MOBILE_USER_AGENT,
  PROBE_RESERVE,
  cookieHeader,
  explain,
  fetchPage,
  fetchTimed,
  subrequestsLeft,
} from "../core.mjs";


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
function extractSnapchatRef(value) {
  const text = String(value ?? "");
  const base = text.match(/(?:www\.)?snapchat\.com\/@([A-Za-z0-9._-]+)\/(spotlight|highlight)\/([^/?#]+)/i);

  return base ? { user: base[1], kind: base[2].toLowerCase(), id: base[3] } : null;
}


async function fetchSnapchatMedia(ref) {
  const page = await fetchPage(`https://www.snapchat.com/@${ref.user}/${ref.kind}/${ref.id}`, {
    "User-Agent": MOBILE_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.snapchat.com/",
    ...cookieHeader("SNAP_COOKIE"),
  });

  if (!page.ok) throw explain("That Snapchat content is not available");

  const html = page.text.replace(/\\u0026/g, "&");
  const files = [];

  if (ref.kind === "spotlight") {
    const video = html.match(/property="og:video"[^>]+content="([^"]+)"/)?.[1];
    const poster = html.match(/property="og:image"[^>]+content="([^"]+)"/)?.[1];

    if (video) files.push({ media: [video], isVideo: true, kind: "video", extension: "mp4" });
    if (poster) files.push({ media: [poster], isVideo: false, kind: "image" });

    if (!files.length) throw explain("That Snapchat Spotlight has no public video");
    return files;
  }

  const urls = [...new Set([...html.matchAll(/"mediaUrl":"([^"]+)"/g)].map((match) => match[1].replace(/\\u0026/g, "&")))]
    .filter((url) => /^https?:\/\//.test(url));

  if (!urls.length) throw explain("That Snapchat highlight has no public photos");

  const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: "https://www.snapchat.com/", Range: "bytes=0-0" };
  /* A highlight can hold more than 50 items, and each one costs a request to
     find out whether it is a photo or a video. With the free-plan cap, asking
     about all of them killed the whole invocation. They are asked about while
     there is headroom and the rest is left unclassified.

     Eight are kept in reserve: afterwards the items still have to be measured
     for the display, and spending the budget down to the last unit here left
     the response one step away from failing. */
  const asked = urls.slice(0, Math.max(1, Math.min(urls.length, subrequestsLeft() - PROBE_RESERVE)));
  const probed = await Promise.all(asked.map(async (url) => {
    try {
      const response = await fetchTimed(url, { headers });

      if (!response.ok) return null;

      const type = (response.headers.get("content-type") ?? "").toLowerCase();

      await response.body?.cancel();

      if (!type) return null;

      return { url, video: type.startsWith("video/") };
    } catch {
      return null;
    }
  }));

  for (const item of probed.filter(Boolean)) {
    if (item.video) files.push({ media: [item.url], isVideo: true, kind: "video", extension: "mp4" });
    else files.push({ media: [item.url], isVideo: false, kind: "image" });
  }

  if (!files.length) throw explain("That Snapchat highlight could not be read");

  /* Say when the highlight came back truncated: otherwise the user assumes
     that was the number of photos and loses content without noticing. */
  if (asked.length < urls.length) {
    console.warn(`Snapchat highlight trimmed to ${asked.length} of ${urls.length} items`);
  }

  return files;
}

/** Dailymotion video: /video/x9l9zoo, dai.ly/x9l9zoo or /embed/video/x9l9zoo. */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectSnapchat(source) {
  const ref = extractSnapchatRef(source);
  if (!ref) return null;

  return {
    files: await fetchSnapchatMedia(ref),
    prefix: `snapchat-${ref.kind}-${ref.id}`,
    referer: "https://www.snapchat.com/",
  };
}
