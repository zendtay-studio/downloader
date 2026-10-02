/* Pornhub. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  DESKTOP_USER_AGENT,
  SAFARI_USER_AGENT,
  withStatus,
  cookieHeader,
  explain,
  fetchPage,
  subrequestsLeft,
} from "../core.mjs";


function extractPornhubKey(value) {
  const text = String(value ?? "");

  return text.match(/[?&]viewkey=([A-Za-z0-9_-]{6,})/i)?.[1]
    ?? text.match(/pornhub\.[a-z.]+\/embed\/([A-Za-z0-9_-]{6,})/i)?.[1]
    ?? text.match(/pornhub\.[a-z.]+\/model\/[a-z0-9_-]+\/videos\/([A-Za-z0-9_-]{6,})/i)?.[1]
    ?? null;
}

/** Clips are view_clip.php: long videos are view_video.php. */


/** Clips are view_clip.php: long videos are view_video.php. */
function extractPornhubClip(value) {
  return /view_clip\.php/i.test(String(value ?? "")) ? extractPornhubKey(value) : null;
}


function extractPornhubPhoto(value) {
  return String(value ?? "").match(/pornhub\.[a-z.]+\/photo\/(\d{5,})/i)?.[1] ?? null;
}


function extractPornhubAlbum(value) {
  return String(value ?? "").match(/pornhub\.[a-z.]+\/album\/(\d{4,})/i)?.[1] ?? null;
}


const PORNHUB_QUALITY = ["2160P", "1440P", "1080P", "720P", "480P", "360P", "240P"];

/**
 * Describes what Pornhub actually returned, so it can say what happened instead
 * of just "not available".
 *
 * This is not decoration: the difference between a deleted video and an age gate
 * is exactly what you need to know to act on it. From a datacenter IP —which is
 * where a Worker comes from— Pornhub answers 200 with the verification page,
 * which is why the error used to be so unhelpful.
 */


/**
 * Describes what Pornhub actually returned, so it can say what happened instead
 * of just "not available".
 *
 * This is not decoration: the difference between a deleted video and an age gate
 * is exactly what you need to know to act on it. From a datacenter IP —which is
 * where a Worker comes from— Pornhub answers 200 with the verification page,
 * which is why the error used to be so unhelpful.
 */
function pornhubSays(html) {
  const text = String(html ?? "");

  if (/AgeVerifyError|ageVerificationOverlay|age_verification/i.test(text)) {
    return "Pornhub returned the age gate instead of the content. It is usually the IP: datacenter ones (a Worker) are on that list, and locally they are not. An age cookie in `PH_COOKIE` can be used to try to skip it.";
  }

  if (/<title[^>]*>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(text)) {
    return "Pornhub returned a block screen, not the video.";
  }

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();

  return title ? `The Pornhub page came back as "${title}" and carried no file.` : "The Pornhub page carried no file.";
}

/** Video (HLS) and images from a Pornhub video. */
/**
 * Clips are short videos: they do not use view_video.php but view_clip.php and
 * serve progressive MP4s from ew/kw.phncdn.com, with open CORS.
 */


/** Video (HLS) and images from a Pornhub video. */
/**
 * Clips are short videos: they do not use view_video.php but view_clip.php and
 * serve progressive MP4s from ew/kw.phncdn.com, with open CORS.
 */
async function fetchPornhubClip(key) {
  const page = await fetchPage(`https://es.pornhub.com/view_clip.php?viewkey=${encodeURIComponent(key)}`, {
    "User-Agent": SAFARI_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...cookieHeader("PH_COOKIE"),
  });

  if (!page.ok) throw explain("Pornhub responded 404: that clip does not exist");

  const html = page.text.replace(/\\\//g, "/").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const quality = (value) => Number(/(\d{3,4})P/.exec(value)?.[1] ?? 0);
  const clips = [...new Set([...html.matchAll(/https?:\/\/(?:ew|kw)\.phncdn\.com\/[^"\x27\s<>\\]+\.mp4[^"\x27\s<>\\]*/g)].map((m) => m[0]))]
    .filter((url) => /\d{3,4}P_\d+[KM]/.test(url))
    .sort((a, b) => quality(b) - quality(a));

  if (!clips.length) throw explain(`That Pornhub clip is no longer available. ${pornhubSays(html)}`);

  const files = [{ media: clips, isVideo: true, kind: "video", extension: "mp4" }];
  const poster = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];

  if (poster) files.push({ media: [poster], isVideo: false, kind: "image" });

  return files;
}

/** A single photo: the og:image is already the original size. */


/** A single photo: the og:image is already the original size. */
async function fetchPornhubPhoto(photoId) {
  const page = await fetchPage(`https://es.pornhub.com/photo/${encodeURIComponent(photoId)}`, {
    "User-Agent": SAFARI_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...cookieHeader("PH_COOKIE"),
  });

  if (!page.ok) throw explain("That Pornhub photo does not exist");

  const html = page.text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const image = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1];

  if (!image) throw explain(`That Pornhub photo is not available. ${pornhubSays(html)}`);

  return [{ media: [image], isVideo: false, kind: "image" }];
}

/**
 * An album.
 *
 * The album page already carries the photos at their original size, so there is
 * no need to enter each one. It used to visit one page per photo and, with 60
 * photos, that is 61 requests: over the free plan's cap of 50, and Cloudflare
 * cut the whole request without saying why.
 *
 * Now the ones already on the page are read first, and only the missing ones are
 * visited individually, and only while there is budget left.
 */


/**
 * An album.
 *
 * The album page already carries the photos at their original size, so there is
 * no need to enter each one. It used to visit one page per photo and, with 60
 * photos, that is 61 requests: over the free plan's cap of 50, and Cloudflare
 * cut the whole request without saying why.
 *
 * Now the ones already on the page are read first, and only the missing ones are
 * visited individually, and only while there is budget left.
 */
async function fetchPornhubAlbum(albumId) {
  const page = await fetchPage(`https://es.pornhub.com/album/${encodeURIComponent(albumId)}`, {
    "User-Agent": SAFARI_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...cookieHeader("PH_COOKIE"),
  });

  if (!page.ok) throw explain("That Pornhub album does not exist");

  const html = page.text.replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const order = [...new Set([...html.matchAll(/href="[^"]*\/photo\/(\d+)"/g)].map((match) => match[1]))];

  if (!order.length) throw explain(`That Pornhub album has no photos. ${pornhubSays(html)}`);

  const photoOf = (id) => new RegExp(
    `https://[a-z0-9.\\-]*phncdn\\.com/[^"'\\s<>\\\\]*original_${id}\\.(?:jpe?g|png)`, "i",
  ).exec(html)?.[0] ?? null;

  const files = [];
  const pending = [];

  /* In the album's order, which is the order the user sees. The ones already on
     the page are used as-is; the rest are fetched one by one and only if there
     is headroom in the budget. */
  for (const id of order) {
    const direct = photoOf(id);

    if (direct) {
      files.push({ media: [direct], isVideo: false, kind: "image" });
      continue;
    }

    if (subrequestsLeft() > 1) pending.push(id);
  }

  if (pending.length) {
    const groups = await Promise.all(pending.map((id) => fetchPornhubPhoto(id).catch(() => [])));

    files.push(...groups.flat());
  }

  const usable = files.filter((file) => file.media?.length);

  if (!usable.length) throw explain(`That Pornhub album has no usable photos. ${pornhubSays(html)}`);

  return usable;
}


async function fetchPornhubMedia(key) {
  const page = await fetchPage(`https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(key)}`, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...cookieHeader("PH_COOKIE"),
  });

  if (!page.ok) throw withStatus(new Error(`Pornhub responded ${page.status}`), page.status);

  const html = page.text.replace(/\\\//g, "/").replace(/&quot;/g, '"');
  const files = [];

  const streams = [...new Set([...html.matchAll(/https:\/\/hv-h\.phncdn\.com\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/g)].map((m) => m[0]))]
    .sort((a, b) => {
      const at = (u) => PORNHUB_QUALITY.findIndex((q) => u.includes(`/${q}_`));
      return at(a) - at(b);
    });

  if (streams.length) {
    files.push({ media: streams, isVideo: true, kind: "video", extension: "m3u8", hls: true });
  }

  // The poster arrives as the ld+json thumbnailUrl or as og:image.
  const poster = html.match(/"thumbnailUrl"\s*:\s*"(https?:[^"]+phncdn\.com[^"]+)"/)?.[1]
    ?? html.match(/property="og:image"\s+content="([^"]+)"/)?.[1]
    ?? html.match(/(https?:\/\/(?:pix|ci)[a-z0-9.\-]*\.phncdn\.com\/[^"'\s<>\\]+original_[^"'\s<>\\]+)/)?.[1];

  if (poster) {
    files.push({ media: [poster.replace(/\u002F/g, "/")], isVideo: false, kind: "image" });
  }

  if (!files.length) throw explain(`No media was found in that Pornhub video. ${pornhubSays(html)}`);

  /* Poster but no video: the signature of an age gate. Returning only the image
     without a warning was the worst option, because the user saw "1 photo" and
     assumed the video had nothing more, instead of a failure that says what to
     look at. */
  if (!streams.length && poster) {
    console.warn(`Pornhub: the page brought a poster but no video. ${pornhubSays(html)}`);
  }

  return files;
}

/** Numeric id of a pin: /pin/<slug>-<id> or /pin/<id>. */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 *
 * Pornhub arrives in four shapes —a clip with a viewkey, a single photo, an
 * album, and a full video page— and each one has its own extractor. They are
 * tried in that order because a link can look like more than one: an album id
 * also matches the photo pattern, and the album is the more specific of the
 * two, so it has to win.
 */
export async function detectPornhub(source) {
  const clip = extractPornhubClip(source);
  const photo = extractPornhubPhoto(source);
  const album = extractPornhubAlbum(source);

  if (clip) {
    return {
      files: await fetchPornhubClip(clip),
      prefix: `pornhub-clip-${clip}`,
      referer: "https://es.pornhub.com/",
    };
  }

  if (photo) {
    return {
      files: await fetchPornhubPhoto(photo),
      prefix: `pornhub-photo-${photo}`,
      referer: "https://es.pornhub.com/",
    };
  }

  if (album) {
    return {
      files: await fetchPornhubAlbum(album),
      prefix: `pornhub-album-${album}`,
      referer: "https://es.pornhub.com/",
    };
  }

  const key = extractPornhubKey(source);

  if (!key) return null;

  return {
    files: await fetchPornhubMedia(key),
    prefix: `pornhub-${key}`,
    referer: "https://www.pornhub.com/",
  };
}
