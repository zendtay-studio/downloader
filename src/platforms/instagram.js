/* Instagram. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its answer is
 * turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a relative
 * import: `tools/build.mjs` strips it when it flattens every file into the
 * single Worker, and there it is already in scope. */
import {
  MOBILE_USER_AGENT,
  withStatus,
  cookieHeader,
  explain,
  fetchPage,
} from "../core.mjs";


export const GOOGLEBOT_USER_AGENT = "Googlebot/2.1 (+http://www.google.com/bot.html)";


/** Instagram reference: public shortcode or numeric id (stories). */
function extractInstagramReference(value) {
  const text = String(value ?? "").trim();
  const shortcode = text.match(/(?:instagram\.com|instagr\.am)\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i)?.[1];

  if (shortcode) return { type: "shortcode", value: shortcode.slice(0, 11) };

  const story = text.match(/instagram\.com\/stories\/[^/]+\/(\d+)/i)?.[1];

  if (story) return { type: "id", value: story };

  const numeric = text.match(/instagram\.com\/(?:[\w-]+\/)?(\d{10,})\/?(?:[?#]|$)/i)?.[1];

  return numeric ? { type: "id", value: numeric } : null;
}


function shortcodeToId(shortcode) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = 0n;

  for (const character of shortcode) {
    id = id * 64n + BigInt(alphabet.indexOf(character));
  }

  return id.toString();
}


function renditionWidth(item) {
  return Number(item.width) || Number(item.url?.match(/_[ps](\d+)x\d+/)?.[1]) || 0;
}

/** The crop box Instagram writes in the URL's `stp`, or `null`. */


/** The crop box Instagram writes in the URL's `stp`, or `null`. */
function cropBox(url) {
  const match = url.match(/stp=c[\d.]*?(\d+)\.(\d+)[a-z]/i);

  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/**
 * The best version of a file among those Instagram offers.
 *
 * It used to filter out any candidate with `stp=c<something>` in the URL, to
 * avoid picking a square crop. The problem is Instagram now puts `stp` on all of
 * them: `stp=c0.0.1200.799a` is the whole image and `stp=c200.0.800.800a` is the
 * cropped square. The pattern was too broad, removed both kinds, left nothing, and
 * the whole post ended up without a single downloadable file.
 *
 * Now they are told apart by their box: the good one is the one with the same
 * ratio as the original, which is exactly the uncropped one. With that,
 *
 *   - cropped ones are discarded, as intended,
 *   - and if the original is not at hand, the largest of what remains is used,
 *     because a cropped image beats none at all.
 *
 * Among those that pass, the largest by declared size; and one with no size mark
 * in the URL is the unscaled original file, which beats them all.
 */


/**
 * The best version of a file among those Instagram offers.
 *
 * It used to filter out any candidate with `stp=c<something>` in the URL, to
 * avoid picking a square crop. The problem is Instagram now puts `stp` on all of
 * them: `stp=c0.0.1200.799a` is the whole image and `stp=c200.0.800.800a` is the
 * cropped square. The pattern was too broad, removed both kinds, left nothing, and
 * the whole post ended up without a single downloadable file.
 *
 * Now they are told apart by their box: the good one is the one with the same
 * ratio as the original, which is exactly the uncropped one. With that,
 *
 *   - cropped ones are discarded, as intended,
 *   - and if the original is not at hand, the largest of what remains is used,
 *     because a cropped image beats none at all.
 *
 * Among those that pass, the largest by declared size; and one with no size mark
 * in the URL is the unscaled original file, which beats them all.
 */
function bestRendition(items, original) {
  const valid = (items ?? []).filter((item) => item?.url);

  if (!valid.length) return undefined;

  const originalRatio = original?.width && original?.height
    ? original.width / original.height
    : null;
  const uncropped = originalRatio
    ? valid.filter((item) => {
        const box = cropBox(item.url);

        return box && Math.abs(box.width / box.height - originalRatio) < 0.02;
      })
    : [];
  const pool = uncropped.length ? uncropped : valid;
  /* The candidate with no size mark in the URL is the original, unscaled file: it
     weighs more and beats the measure of any `_s1080x1080`. It is preferred over
     all. Only if there is none, the largest of those carrying a mark. */
  const unscaled = pool.find((item) => !/_[ps]\d+x\d+/.test(item.url));

  if (unscaled) return unscaled;

  return pool.sort((a, b) => renditionWidth(b) - renditionWidth(a))[0];
}


function findProduct(root, expectedId) {
  const stack = [root];
  const visited = new WeakSet();

  while (stack.length) {
    const value = stack.pop();

    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);

    const publicValue = value.if_not_gated_logged_out;

    if (
      publicValue &&
      [publicValue.pk, publicValue.id].some((id) => String(id) === expectedId)
    ) {
      return publicValue;
    }

    if (
      [value.pk, value.id].some((id) => String(id) === expectedId) &&
      (value.video_versions || value.carousel_media || value.image_versions2)
    ) {
      return value;
    }

    for (const child of Object.values(value)) stack.push(child);
  }

  return null;
}


function extractInstagramMedia(product) {
  const items = product.carousel_media ?? [product];

  return items.flatMap((item) => {
    const original = { width: item.original_width, height: item.original_height };
    const video = bestRendition(item.video_versions, original);
    const image = bestRendition(item.image_versions2?.candidates, original);
    const selected = video ?? image;
    /* The fallback changed name depending on the page version: it used to be
       `display_url` and now it is `display_uri`. Both are accepted, and in both
       cases it is a square crop, so it goes last: only when there is no candidate
       at all. */
    const fallback = item.display_uri ?? item.display_url;

    if (!selected && !fallback) return [];

    return [{
      media: [selected?.url ?? fallback],
      isVideo: Boolean(video),
      kind: video ? "video" : "image",
    }];
  });
}

/** Stories and private content: official API only, and it requires a session
 * cookie. */


/** Stories and private content: official API only, and it requires a session
 * cookie. */
async function fetchInstagramById(id) {
  const page = await fetchPage(`https://i.instagram.com/api/v1/media/${id}/info/`, {
    "User-Agent": MOBILE_USER_AGENT,
    "X-IG-App-ID": "936619743392459",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.instagram.com/",
    ...cookieHeader("IG_COOKIE"),
  });

  /* The status is looked at BEFORE trying to read anything. Without this a 429
     —which is an IP limit— fell through to the message below and came out saying
     the story is only for signed-in sessions: a diagnosis that blames the user
     for something they did not do, and which is also the first thing anyone would
     try. It is checked now because the body of a 429 is not the JSON that is
     expected, and without this the error was inevitable. */
  if (page.status === 429 || page.status === 403) {
    throw Object.assign(
      new Error(
        "Instagram is rate-limiting requests from this server. It is not the post: "
        + "it is Cloudflare's IP, which is shared between many Workers and runs out of turns sooner. "
        + "Wait a few minutes and try again.",
      ),
      { status: page.status },
    );
  }

  let payload = null;

  try {
    payload = JSON.parse(page.text);
  } catch {}

  const files = payload?.items?.[0] ? extractInstagramMedia(payload.items[0]) : [];

  /* Only when the request went through and there is still no media. Here it really
     can be the session's fault, and the message says so. */
  if (!files.length) {
    throw explain("That story is not available: Instagram only serves it to signed-in sessions");
  }

  return files;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 *
 * Instagram arrives in two shapes that need different requests: a permalink
 * carries a shortcode that has to be turned into the post, while a story link
 * already carries the media id. The story branch goes first because a story
 * link has no shortcode and the permalink branch would not recognise it.
 */
export async function detectInstagram(source) {
  const reference = extractInstagramReference(source);

  if (!reference) return null;

  if (reference.type === "id") {
    return {
      files: await fetchInstagramById(reference.value),
      prefix: `instagram-${reference.value}`,
      referer: "https://www.instagram.com/",
    };
  }

  const shortcode = reference.value;
  const page = await fetchPage(`https://www.instagram.com/p/${shortcode}/`, {
    "User-Agent": GOOGLEBOT_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...cookieHeader("IG_COOKIE"),
  });

  /* Instagram limits by IP, and Cloudflare's addresses are shared between many
     Workers, so they run out of turns sooner. Neither the 429 nor the 403 that
     usually follows has anything to do with this post: it is the address.
     Saying so is more useful than handing over the bare status, which suggests
     the post is broken when the only thing that broke was the turn.

     The status travels with the error so the HTTP answer is a real 429 and not
     a 500: whoever watches the Worker can tell "Instagram is limiting us" from
     "we broke something", which are different things. */
  if (page.status === 429 || page.status === 403) {
    throw Object.assign(
      new Error(
        "Instagram is rate-limiting requests from this server. It is not the post: "
        + "it is Cloudflare's IP, which is shared between many Workers and runs out of turns sooner. "
        + "Wait a few minutes and try again.",
      ),
      { status: page.status },
    );
  }

  if (!page.ok) throw withStatus(new Error(`Instagram responded ${page.status}`), page.status);

  const html = page.text;
  const expectedId = shortcodeToId(shortcode);
  let product = null;

  for (const match of html.matchAll(
    /<script\b[^>]*\bdata-sjs[^>]*>(\{.+?\})<\/script>/gs,
  )) {
    try {
      product = findProduct(JSON.parse(match[1]), expectedId);
    } catch {}

    if (product) break;
  }

  if (!product) throw explain("No public Instagram content was found");

  return {
    files: extractInstagramMedia(product),
    prefix: "instagram",
    referer: "https://www.instagram.com/",
  };
}
