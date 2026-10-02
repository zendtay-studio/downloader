/* Shared ground for every platform extractor.
 *
 * This file exists so that `src/platforms/*.mjs` only holds the code that
 * knows about one site, and nothing else. What belongs here is the code whose
 * reason for existing is not a site: the HTTP plumbing, the error helpers, the
 * cookies, the subrequest budget and the media naming.
 *
 * Everything is deliberately pure Web Standard: no `node:fs`, `node:stream` or
 * `node:url`, so both hosts can load it unchanged — the Node server and the
 * Cloudflare Worker, which has neither a filesystem nor Node streams. The only
 * Node-specific part (downloading to disk from the terminal) lives separately in
 * `cli.mjs`. */
export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/** Pornhub serves a different page (without the mp4s) to desktop Chrome, so its
 *  clips and photos go through Safari. */
export const SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const PAGE_TIMEOUT = 15000;
export const MEDIA_TIMEOUT = 20000;

/* Subrequests held back for last: measuring the size of the items that will be
   displayed. It is spent by the resolver, not by the media collectors. */
export const PROBE_RESERVE = 8;

/* The free plan allows 50 subrequests per request. Counting them by hand is the
   only way to fail with a sentence that says what to do, instead of a 1101 from
   the edge that explains nothing. */
export const SUBREQUEST_LIMIT = 50;

let subrequests = 0;

export function resetSubrequests() {
  subrequests = 0;
}

export function subrequestsLeft() {
  return Math.max(0, SUBREQUEST_LIMIT - PROBE_RESERVE - subrequests);
}

export function spendSubrequest() {
  subrequests += 1;

  return subrequests <= SUBREQUEST_LIMIT;
}

/**
 * The best HLS variant out of a master playlist.
 *
 * Three platforms here serve HLS and none of them lists the renditions in a useful
 * order: Vimeo's master of one video went 720p, 270p, 360p, 540p, and Rutube's
 * answered 155 kbps before 1080p. "Take the first" and "take the last" are both
 * wrong here, so the size is read out of the tag and compared — `RESOLUTION=` where
 * there is one, `BANDWIDTH=` otherwise.
 *
 * Only AVC variants are considered. Every one of these also serves HEVC and AV1,
 * and the playlist is handed to a browser to play: a rendition the browser cannot
 * decode is a black rectangle that nothing in the page could explain. `avc1` in
 * `CODECS=` is the one every browser reads.
 *
 * Returns the URI as written in the playlist, not resolved: the callers join it
 * against the manifest, which is the only thing that knows the base.
 *
 * It lives here rather than in either file because it is the same decision twice.
 */
export function bestVariant(manifest) {
  const lines = manifest.split("\n");
  const candidates = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const pixels = Number(/RESOLUTION=(\d+)x/.exec(line)?.[1] ?? 0);
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
    const codecs = /CODECS="([^"]+)"/.exec(line)?.[1] ?? "";
    const uri = lines[i + 1]?.trim();

    if (!uri) continue;
    if (codecs && !/avc1/i.test(codecs)) continue;

    candidates.push({ pixels, bandwidth, uri });
  }

  if (!candidates.length) return null;

  /* Ranked in ONE unit, never two.
     This used to score each variant as `pixels || bandwidth` and sort by that,
     which put pixels and bits per second in the same column: a 480x270 rendition
     scored 480 and one with no `RESOLUTION` at all scored its raw bitrate, so
     anything above 480 — that is, nearly everything — beat the 480p one on the
     strength of a number that does not measure the same thing. Against a 1080p
     entry at a low bitrate it picked the wrong file every time.

     Width is what "best" means to whoever asked, so when the master declares it
     anywhere, only the entries that declare it are ranked: they are comparable
     with each other, and an entry without a width cannot be placed among them
     without inventing the conversion. Masters that declare no width at all fall
     back to bitrate, which is then the only unit there is. */
  const withHeight = candidates.filter((c) => c.pixels > 0);
  const measure = withHeight.length ? "pixels" : "bandwidth";

  candidates.sort((a, b) => b[measure] - a[measure]);

  return candidates[0].uri;
}

/**
 * Error carrying a message meant to be read by the user verbatim.
 *
 * It exists because the API rewrites platform errors into short, kind texts,
 * and without this marker a diagnosis would be flattened into a "that link
 * couldn't be read" that says nothing.
 */
export function explain(text) {
  return Object.assign(new Error(text), { user: true });
}

/**
 * Carries the HTTP status a platform answered with, so the response says what
 * actually happened.
 *
 * A platform that answers 404 means the post is not there, and a response that
 * says 500 for that is lying twice: it tells the caller to retry something that
 * will never work, and it puts a dead link into the Worker's error rate next to
 * real outages, where the two become indistinguishable. It matters most for the
 * limits the README spends a section on: a 429 from a platform has to arrive as
 * a 429, or nobody can tell "they are limiting us" from "we are broken".
 *
 * The status is passed through rather than second-guessed, with one floor: a
 * status that is not a real HTTP code cannot be put on the wire, so it becomes
 * 502. What must NOT happen is falling back to 500, because that is the answer
 * this whole mechanism exists to avoid.
 */


/**
 * Carries the HTTP status a platform answered with, so the response says what
 * actually happened.
 *
 * A platform that answers 404 means the post is not there, and a response that
 * says 500 for that is lying twice: it tells the caller to retry something that
 * will never work, and it puts a dead link into the Worker's error rate next to
 * real outages, where the two become indistinguishable. It matters most for the
 * limits the README spends a section on: a 429 from a platform has to arrive as
 * a 429, or nobody can tell "they are limiting us" from "we are broken".
 *
 * The status is passed through rather than second-guessed, with one floor: a
 * status that is not a real HTTP code cannot be put on the wire, so it becomes
 * 502. What must NOT happen is falling back to 500, because that is the answer
 * this whole mechanism exists to avoid.
 */
export function withStatus(error, status) {
  const code = Number(status);
  const usable = Number.isInteger(code) && code >= 400 && code <= 599;

  return Object.assign(error, { status: usable ? code : 502 });
}

/* The session cookies that were injected by `setSecrets()`. Reading them on
   each call is idempotent and cannot leave a value from another one behind. */
let secrets = {};


export function setSecrets(env) {
  secrets = env ?? {};
}


export function cookieValue(variable) {
  /* First whatever the Worker hands over. Then `process.env`, for when this runs
     in Node —the terminal CLI and the local server—, where it does exist. */
  return secrets[variable]?.trim()
    || globalThis.process?.env?.[variable]?.trim()
    || undefined;
}


export function cookieHeader(variable) {
  const cookie = cookieValue(variable);

  return cookie ? { Cookie: cookie } : {};
}

/**
 * Fetches a page and reads it whole, with a time cap.
 *
 * One page request, with a byte cap and a retry. Fills in any missing headers
 * with browser-like values and retries once: some servers (Reddit among them)
 * answer 403 intermittently at the edge, and a repeat gets through.
 *
 * `init` is merged as-is into the `fetch` options, and that is what allows a
 * POST: ssstik.io only answers POST, and without this its extractor would be
 * issuing a GET that does not exist. By default it is still a GET, which is
 * what all the calls that were already there do.
 *
 * `limit` cuts the body read off at that number of bytes. The platform
 * extractors know which pages they expect and almost none of them need the
 * whole HTML. The universal one does visit pages of unknown shape, and an
 * `await response.text()` over an 80 MB site in the Worker is an expensive way
 * to run out of memory: the body arrives whole inside the isolate. With a cap
 * the read stops as soon as it fills up and the rest is discarded.
 */
export async function fetchPage(url, headers, attempt = 0, limit = 0, init = {}, timeout = PAGE_TIMEOUT) {
  if (!spendSubrequest()) {
    return { ok: false, status: 0, text: "", error: new Error("the request budget ran out") };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
      signal: controller.signal,
    });

    if (!response.ok && attempt === 0 && [403, 429, 500, 502, 503, 504].includes(response.status)) {
      /* A 429 carrying `Retry-After` is an explicit "come back later": retrying
         at the usual 900 ms goes directly against what the server asked for and
         turns a one-minute limit into a longer block. Wait for what it says,
         and if it says nothing, the shortest wait that does not worsen the
         counter. */
      const retryAfter = Number(response.headers.get("retry-after"));
      const espera = response.status === 429
        ? (Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 2000)
        : 900;

      await new Promise((done) => setTimeout(done, espera));

      return fetchPage(url, headers, attempt + 1, limit, init, timeout);
    }

    /* The text is read in chunks and stops as soon as the cap fills. If the cut
       lands in the middle of a UTF-8 character, `slice` splits the character
       and a replacement character comes out at the end — that is fine, it is
       HTML that gets truncated anyway. */
    let text = "";
    let read = 0;

    if (!response.ok) {
      await response.body?.cancel();
    } else if (limit > 0 && response.body) {
      const reader = response.body.getReader();
      const trozos = [];

      while (read < limit) {
        const { done, value } = await reader.read();

        if (done) break;

        trozos.push(value);
        read += value.byteLength;
      }

      await reader.cancel().catch(() => {});
      text = new TextDecoder("utf-8").decode(
        (() => {
          const joined = new Uint8Array(read);
          let offset = 0;

          for (const trozo of trozos) {
            joined.set(trozo, offset);
            offset += trozo.byteLength;
          }

          return joined;
        })(),
      );
    } else if (response.ok) {
      text = await response.text();
    }

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      url: response.url,
      text,
      truncated: limit > 0 && read >= limit,
    };
  } catch (error) {
    if (attempt === 0) {
      await new Promise((done) => setTimeout(done, 900));
      return fetchPage(url, headers, attempt + 1, limit, init, timeout);
    }

    return { ok: false, status: 0, text: "", error };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with a time cap on the headers; the body flows with no clock on it. */
export async function fetchTimed(url, options = {}, ms = MEDIA_TIMEOUT) {
  if (!spendSubrequest()) {
    throw explain("This link needs more requests than the free plan allows; the paid plan is required.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


const PLATFORM_HOSTS = {
  instagram: ["instagram.com", "instagr.am"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com"],
  pinterest: ["pinterest.com", "pin.it"],
  pornhub: ["pornhub.com", "pornhub.org", "pornhubpremium.com"],
  facebook: ["facebook.com", "fb.com", "fb.watch"],
  threads: ["threads.com", "threads.net"],
  x: ["x.com", "twitter.com", "mobile.twitter.com", "nitter.net", "fxtwitter.com", "vxtwitter.com"],
  ok: ["ok.ru", "odnoklassniki.ru", "odnoklassniki.com"],
  bluesky: ["bsky.app", "bsky.social"],
  dailymotion: ["dailymotion.com", "dai.ly", "geo.dailymotion.com"],
  snapchat: ["snapchat.com", "t.snapchat.com"],
  // Kwai gives one domain per country: kwai.com, kwai.fr, kwai.com.br, kwai.mx…
  kwai: ["kwai.com", "kuaishou.com", "gifshow.com"],
  spotify: ["spotify.com", "spotify.link", "spoti.fi"],
  reddit: ["reddit.com", "redd.it", "redditmedia.com"],
  // The app's short links live on on.soundcloud.com and redirect to the
  //permalink; snd.sc is the short domain used for sharing.
  soundcloud: ["soundcloud.com", "snd.sc", "on.soundcloud.com", "w.soundcloud.com"],
  vimeo: ["vimeo.com"],
  streamable: ["streamable.com"],
  rutube: ["rutube.ru"],
  bilibili: ["bilibili.com", "b23.tv"],
  loom: ["loom.com"],
};

/** Platform of a link by domain; the path does not matter. */
export function platformOf(input) {
  // `spotify:track:<id>` URIs are not URLs: they are translated before the host
  // is looked at.
  const text = String(input ?? "").trim().replace(
    /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]{10,})/i,
    "https://open.spotify.com/$1/$2",
  );

  if (!text) return null;

  let host;

  try {
    host = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }

  const bare = host.replace(/^www\./, "");

  // Kwai's per-country domains do not fit in a list: all of them are accepted.
  if (/^kwai\.[a-z]{2,4}(?:\.[a-z]{2,4})?$/.test(bare)) return "kwai";

  return Object.keys(PLATFORM_HOSTS).find((id) =>
    PLATFORM_HOSTS[id].some((allowed) => bare === allowed || bare.endsWith(`.${allowed}`)),
  ) ?? null;
}

/**
 * Cookies to send, starting with a secret if one is set.
 *
 * It used to start empty and only pick up what the responses set, which meant
 * there was no way to arrive at Facebook already signed in — and Facebook is
 * the one platform here that hands out no video URL at all without a session: a
 * reel behind a login comes back as a JS shell with nothing in it, and no
 * combination of user agents or URL shapes changes that. `FB_COOKIE` is the way
 * in, and it is optional, so nothing breaks when it is not set.
 */
export function cookieJar(seed) {
  const jar = new Map();

  for (const par of String(seed ?? "").split(";")) {
    const eq = par.indexOf("=");

    if (eq > 0) jar.set(par.slice(0, eq).trim(), par.slice(eq + 1).trim());
  }

  return {
    header: () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ") || undefined,
    absorb: (headers) => {
      for (const raw of headers?.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");

        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
  };
}

/* ── TikTok via ssstik.io ──────────────────────────────────────────────────
 *
 * ssstik.io has no public API: what its site does is a POST to /abc?url=dl with
 * a fixed token written on its page. There is no cookie, no captcha and no
 * signature to replicate; it answers HTML with the links already assembled.
 *
 * What it provides is not content we did not have: it is the SAME file, served by
 * its CDN. That does have value, because tiktokcdn.com's direct link answers 403
 * without a Referer header —measured— and forces a trip through our proxy.
 *
 * The limit is what you need to keep in mind. It holds up to about one request
 * every 30 seconds per IP, and when you go over it does NOT error: it returns a
 * 200 with an empty body. That is why the result is searched for the links and
 * never by status alone, and why there are two attempts with a wait between them.
 *
 * If the cooldown is still active it returns null without having asked anything,
 * so as not to spend a request that is known to come back empty.
 */


export async function openMediaResponse(file, headers) {
  let blocked = null;
  let failed = null;

  for (const url of [...(file.media ?? []), ...(file.fallback ?? [])]) {
    try {
      const response = await fetchTimed(url, { headers });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

      if (!response.ok || !response.body) {
        await response.body?.cancel();

        if (/^(?:401|403|451)$/.test(String(response.status))) {
          blocked = response.status;
        } else {
          failed = response.status;
        }

        continue;
      }

      if (contentType && !/^(?:video|image|audio)\//.test(contentType) && !/(?:mp4|m4a|octet-stream|binary)/.test(contentType)) {
        await response.body.cancel();
        continue;
      }

      return response;
    } catch {}
  }

  if (blocked) {
    throw withStatus(new Error(
      `The platform's server blocked the download (HTTP ${blocked}). ` +
      "Usually an IP or region restriction; try from another network.",
    ), blocked);
  }

  if (failed) throw withStatus(new Error(`The media server responded ${failed}`), Number(failed) || 502);

  throw withStatus(new Error("The media file could not be downloaded"), 502);
}


const KNOWN_EXTENSIONS = /^(jpe?g|png|webp|mp4|mov|webm|m4a|mp3|ogg|opus|m3u8|ts)$/i;


function extensionOf(value) {
  const text = String(value ?? "");
  const known = text.match(/(jpe?g|png|webp|mp4|webm|mov|m4a|mp3|ogg|opus|m3u8)/i)?.[1];

  return known && KNOWN_EXTENSIONS.test(known) ? known.toLowerCase() : null;
}


export function mediaExtension(file, url, contentType = "") {
  if (file.kind === "audio") {
    return /webm|opus|ogg/i.test(contentType) ? "opus"
      : /mpeg|mp3/i.test(contentType) ? "mp3"
      : /aac/i.test(contentType) ? "m4a"
      : (file.extension && /^(m4a|mp3|opus|ogg|aac)$/i.test(file.extension) ? file.extension.toLowerCase() : "m4a");
  }

  // The server's real type wins: then the file's extension, and then the URL. The
  // path can be relative —the server's own redirects are `/api/media?…`— so it is
  // resolved against a base instead of blowing up with "Invalid URL".
  let path = "";

  try {
    path = new URL(url, "https://localhost").pathname;
  } catch {}

  return extensionOf(contentType)
    ?? (file.extension && KNOWN_EXTENSIONS.test(file.extension) ? file.extension.toLowerCase() : null)
    ?? extensionOf(path.match(/\.([a-z0-9]{2,5})$/i)?.[1])
    ?? (file.isVideo ? "mp4" : "jpg");
}


export function mediaName(prefix, extension, index, total, label) {
  // A label of its own —a song title, a photo— is used instead of the platform
  // prefix, because it says more than the prefix does and it is already unique.
  //
  // But a label that is only a resolution is NOT a name: `1280x720` on its own gave
  // every Streamable file the name `1280x720.mp4`, with the platform nowhere in it
  // and two files of the same resolution indistinguishable. A label made only of
  // digits, an `x` and a few letters is a size, so it goes after the prefix as a
  // suffix: `streamable-hn8hq-1280x720.mp4` says both what it is and how big.
  const clean = String(label ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  const onlyDimensions = /^\d+\s*[x×]\s*\d+$/i.test(clean);

  if (clean && !onlyDimensions) return `${clean}.${extension}`;

  const suffix = total > 1 ? `-${index + 1}` : "";

  if (clean && onlyDimensions) return `${prefix}${suffix}-${clean}.${extension}`;

  return `${prefix}${suffix}.${extension}`;
}
