/* TikTok. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its answer is
 * turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a relative
 * import: `tools/build.mjs` strips it when it flattens every file into the
 * single Worker, and there it is already in scope. */
import {
  DESKTOP_USER_AGENT,
  MOBILE_USER_AGENT,
  cookieJar,
  cookieValue,
  explain,
  fetchPage,
  fetchTimed,
  platformOf,
} from "../core.mjs";

const TIKTOK_REFERER = "https://www.tiktok.com/";

const TIKTOK_APP_USER_AGENT =
  "com.zhiliaoapp.musically/2022600040 (Linux; U; Android 12; en_US; Redmi Note 11; Build/SP1A.210812.016)";

// Chrome 140 and 131 get the WAF challenge; these versions do return the payload
// with the /aweme/v1/play/ endpoint, which is the one that can be downloaded.


// Chrome 140 and 131 get the WAF challenge; these versions do return the payload
// with the /aweme/v1/play/ endpoint, which is the one that can be downloaded.
const TIKTOK_BROWSER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (compatible; Chrome-Lighthouse)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 GPTBot/1.2",
  "DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot",
  "Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)",
  DESKTOP_USER_AGENT,
  MOBILE_USER_AGENT,
  TIKTOK_APP_USER_AGENT,
];

// TikTok blocks Googlebot (403 of 9 bytes); these signatures do get through.


// TikTok blocks Googlebot (403 of 9 bytes); these signatures do get through.

function walkStrings(root) {
  const out = [];
  const stack = [root];

  while (stack.length) {
    const value = stack.pop();

    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) stack.push(...value);
    else if (value && typeof value === "object") stack.push(...Object.values(value));
  }

  return out;
}


export function extractTikTokVideoId(url) {
  const text = String(url ?? "");

  /* The host decides first. `tiktok.com/@…` is a substring, not an address, so
     `https://anything.example/tiktok.com/@u/video/123` satisfied the pattern and
     this extractor then asked ssstik.io about it. More to the point, the
     candidate list below includes the link as it was pasted and every entry in
     it is fetched with `TT_COOKIE` attached, so an unanchored pattern here hands
     a TikTok session cookie to whichever host wrote the link. */
  if (platformOf(text) !== "tiktok") return null;

  return text.match(/(?:www\.|m\.)?tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i)?.[1];
}

/** Walks the InnerTube JSON and pulls the playlist's videos out. */


function parseJsonScripts(html, id) {
  const scripts = [];
  const pattern = new RegExp(
    `<script\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>([\\s\\S]*?)<\\/script>`,
    "gi",
  );

  for (const match of html.matchAll(pattern)) {
    try {
      scripts.push(JSON.parse(match[1]));
    } catch {}
  }

  return scripts;
}


function rankTikTokNode(node) {
  if (!node || typeof node !== "object") return 0;
  if (node.imagePost?.images?.length) return 3;
  if (node.playAddr) return 2;
  if (node.video?.playAddr) return 1;
  return 0;
}

/** Locates the post inside TikTok's JSON: works for video and photos alike. */


/** Locates the post inside TikTok's JSON: works for video and photos alike. */
function findTikTokItem(root, expectedId) {
  const stack = [root];
  const visited = new WeakSet();
  let best = null;

  while (stack.length) {
    const value = stack.pop();

    if (!value || typeof value !== "object" || visited.has(value)) continue;

    visited.add(value);

    if (String(value.id) === expectedId && rankTikTokNode(value) > rankTikTokNode(best)) {
      best = value;
    }

    for (const child of Object.values(value)) stack.push(child);
  }

  return best;
}

/** Short links (vt./vm./t) redirect to the canonical post. */


/** Short links (vt./vm./t) redirect to the canonical post. */
async function expandTikTokUrl(value) {
  if (/tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i.test(value)) return value;

  try {
    const response = await fetchTimed(value, {
      headers: {
        "User-Agent": MOBILE_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    }, 10000);

    const finalUrl = response.url ?? "";
    const found = finalUrl.match(/tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i)?.[0];

    await response.body?.cancel();

    return found ? `https://www.${found}` : value;
  } catch {
    return value;
  }
}

/* The TikTok comment that used to be here described a retry with the mobile
   User-Agent that is no longer in this file, and hanging below it was
   `mediaEnough`, which nobody calls. Both gone: the comment was wrong about what
   it had below it and nobody used the function. */

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
const SSSTIK = {
  homeUrl: "https://ssstik.io/",
  queryUrl: "https://ssstik.io/abc?url=dl",
  // Cooldown between requests. A Worker has no memory between invocations —there
  // is nowhere to keep the time— but isolates are reused, so this is shared by
  // every request landing on the same one. It is not a lock: two different
  // isolates can ask at the same time and both come back empty-handed, which is
  // exactly what happens with this service's cooldown. A Durable Object would be
  // a real lock.
  cooldown: 26_000,
  lastCall: 0,
  token: null,
  tokenSince: 0,
};

/* Timeout for ssstik.io, well under the 15 s usually allowed. It is a fallback
   extractor: if it is slow, our own extractor —slower but always there— is the
   better option, so before waiting fifteen seconds on a third-party service it is
   better to have already gone to ours. With two attempts and the wait between
   them, the worst that can happen is nine seconds. */
const SSSTIK_PLAZO = 4000;


const SSSTIK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * The `tt` token is written on the page and does not change. It is read once and
 * kept for an hour: fetching the home page just to get the token would spend
 * quota on the only request there is.
 */


/**
 * The `tt` token is written on the page and does not change. It is read once and
 * kept for an hour: fetching the home page just to get the token would spend
 * quota on the only request there is.
 */
async function ssstikToken() {
  const ahora = Date.now();

  if (SSSTIK.token && ahora - SSSTIK.tokenSince < 3_600_000) return SSSTIK.token;

  const homeUrl = await fetchPage(SSSTIK.homeUrl, { "User-Agent": SSSTIK_UA });

  if (!homeUrl.ok) return null;

  const token = homeUrl.text.match(/s_tt\s*=\s*'([^']+)'/)?.[1] ?? null;

  if (token) {
    SSSTIK.token = token;
    SSSTIK.tokenSince = ahora;
  }

  return token;
}

/** A query to ssstik.io. Returns the HTML, or an empty string if it did not help. */


/** A query to ssstik.io. Returns the HTML, or an empty string if it did not help. */
async function ssstikFetch(url, token) {
  const body = new URLSearchParams({ id: url, locale: "en", tt: token, debug: "ab=1&loc=DO" });

  const page = await fetchPage(SSSTIK.queryUrl, {
    "Content-Type": "application/x-www-form-urlencoded",
    "HX-Request": "true",
    "HX-Current-URL": SSSTIK.homeUrl,
    "HX-Target": "target",
    Referer: SSSTIK.homeUrl,
    Origin: "https://ssstik.io",
    "User-Agent": SSSTIK_UA,
  }, 0, 300_000, { method: "POST", body: body.toString() }, SSSTIK_PLAZO);

  if (!page.ok || !page.text) return "";

  return page.text;
}

/**
 * Lo promise hay escondido en las rutas de ssstik.
 *
 * Each route is `/a/`, `/m/` or `/p/` followed by a base64 that is a TikTok URL.
 * It is tempting to use the one inside and skip a third party's CDN, and for the
 * audio it works: `api16-normal-useast5.tiktokv.us/aweme/v1/play/?…` answers 200
 * with no `Referer` and its 603 996 bytes, and it is a real TikTok address. For
 * images it does not: both answer 403, and also with TikTok's `Referer` set —the
 * host is `tiktokcdn-us.com`, which is stricter than the `tiktokcdn.com` our own
 * extractor already uses—.
 *
 * So the wrappers are used, since those do serve on their own, and the real URL
 * inside is left as the audio's second option. Nothing more: it stays in the
 * candidate list of the same item, which the pipeline tries until one answers, so
 * nothing is lost and it decides nothing on its own.
 *
 * One warning about the text pasted from these routes: when copied it can arrive
 * with an extra `^`, which is not in the base64 alphabet, and on decoding, the
 * URL's `&` come out as `x` and `^`. With that the image's signature is wrong and
 * the 403 is our own doing. That is why the URL is decoded from what ssstik
 * answers, and not from what was sent to us.
 */


/**
 * Lo promise hay escondido en las rutas de ssstik.
 *
 * Each route is `/a/`, `/m/` or `/p/` followed by a base64 that is a TikTok URL.
 * It is tempting to use the one inside and skip a third party's CDN, and for the
 * audio it works: `api16-normal-useast5.tiktokv.us/aweme/v1/play/?…` answers 200
 * with no `Referer` and its 603 996 bytes, and it is a real TikTok address. For
 * images it does not: both answer 403, and also with TikTok's `Referer` set —the
 * host is `tiktokcdn-us.com`, which is stricter than the `tiktokcdn.com` our own
 * extractor already uses—.
 *
 * So the wrappers are used, since those do serve on their own, and the real URL
 * inside is left as the audio's second option. Nothing more: it stays in the
 * candidate list of the same item, which the pipeline tries until one answers, so
 * nothing is lost and it decides nothing on its own.
 *
 * One warning about the text pasted from these routes: when copied it can arrive
 * with an extra `^`, which is not in the base64 alphabet, and on decoding, the
 * URL's `&` come out as `x` and `^`. With that the image's signature is wrong and
 * the 403 is our own doing. That is why the URL is decoded from what ssstik
 * answers, and not from what was sent to us.
 */
function decodeSsstik(base64) {
  try {
    // URL-safe base64: uses - and _ instead of + and /, and sometimes lacks the
    // padding.
    const limpio = decodeURIComponent(base64).replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (limpio.length % 4)) % 4);
    const text = new TextDecoder().decode(Uint8Array.from(atob(limpio + padding), (c) => c.charCodeAt(0)));

    return /^https:\/\//.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Pulls the three files out of the response: the video, the audio and the cover. */


/** Pulls the three files out of the response: the video, the audio and the cover. */
function ssstikFiles(html) {
  // Only its CDN is accepted. The response comes from ssstik and not from the
  // requester, but checking the host is what separates "a link to a media file"
  // from "an address someone put in the response".
  const fromTikcdn = (value) => {
    try {
      return new URL(value).hostname.endsWith("tikcdn.io") ? value.replace(/&amp;/g, "&") : null;
    } catch {
      return null;
    }
  };

  // The route is /a/, /m/ or /p/ followed by the base64. It is read via `src` or
  // `href`: the cover and the audio come in an href, and the profile avatar in a
  // src. The `[^"]` stays inside the URL so it does not eat the attribute.
  const wrapper = (letter) => {
    const pattern = new RegExp(`https:\\/\\/tikcdn\\.io\\/ssstik\\/${letter}\\/([A-Za-z0-9+/_-]{40,}={0,2})`, "g");
    const trozos = [...html.matchAll(pattern)].map((m) => m[1]);

    for (const segment of trozos) {
      const url = fromTikcdn(`https://tikcdn.io/ssstik/${letter}/${segment}`);
      if (url) return { url, real: decodeSsstik(segment) };
    }

    return null;
  };

  const video = fromTikcdn(html.match(/href="(https:\/\/tikcdn\.io\/ssstik\/\d+[^"]*)"/)?.[1] ?? "");
  const audio = wrapper("m");
  const cover = wrapper("p");

  if (!video && !audio && !cover) return null;

  const files = [];

  /* The type is set by hand and not deduced from the response. Its links carry
     no extension in the path and answer `application/octet-stream`, so there is
     no way to tell from the header what they are: the video is the one not under
     `/m/`, and the audio the one that is. */
  /* `direct` says its URL serves on its own. The tiktokcdn.com ones answer 403
     without their site's Referer and therefore have to go through the proxy, but
     the tikcdn.io ones do not ask for it: sending them anyway would spend a
     subrequest and the Worker's bandwidth for nothing, and would leave the file
     in the hands of an unneeded proxy.
     `accept` is for the same reason: they answer `application/octet-stream`,
     which does not match the `video/` that probing expects by default, and
     without this they are discarded and the item comes out with no size. Each of
     these files has exactly one URL, so a loose filter cannot pick wrong. */
  if (video) {
    // `converted` stops the routine below from cloning the same mp4 as m4a:
    // the real audio already comes separately and is a different file, not the same
    // renombrado.
    files.push({
      media: [video],
      isVideo: true,
      kind: "video",
      extension: "mp4",
      converted: true,
      direct: true,
      accept: "octet-stream",
    });
  }

  if (audio) {
    // TikTok's URL goes second, not first: ssstik's wrapper is what has been
    // measured as stable, while TikTok's carries a `signaturev3` that depends on
    // who is asking. The other way round, if the wrapper falls the item is lost;
    // this way it only falls if both do.
    files.push({
      media: [audio.url, audio.real].filter(Boolean),
      isVideo: false,
      kind: "audio",
      extension: "mp3",
      direct: true,
      accept: "octet-stream",
    });
  }

  /* The cover closes the list and is what the photo item returns when
     ssstik answers: without it there were two files instead of three,
     because our own path does pull it out and this one does not. */
  if (cover) {
    files.push({
      media: [cover.url],
      isVideo: false,
      kind: "image",
      extension: "jpg",
      direct: true,
      accept: "image/|octet-stream",
    });
  }

  return files;
}

/**
 * The files for a TikTok link according to ssstik.io, or `null` if there is no
 * way.
 *
 * `null` means two things at once —still cooling down, or the quota is used up—
 * and both are answered the same way: carrying on with our own extractor, which
 * is slower but has no limit.
 */


/**
 * The files for a TikTok link according to ssstik.io, or `null` if there is no
 * way.
 *
 * `null` means two things at once —still cooling down, or the quota is used up—
 * and both are answered the same way: carrying on with our own extractor, which
 * is slower but has no limit.
 */
async function fetchTikTokSSSTIK(sourceUrl) {
  if (Date.now() - SSSTIK.lastCall < SSSTIK.cooldown) return null;

  // It is stamped on attempting, not on succeeding: if the call comes back
  // empty it means the cooldown is still active, and retrying immediately
  // would spend another one.
  SSSTIK.lastCall = Date.now();

  const token = await ssstikToken();

  if (!token) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));

    const files = ssstikFiles(await ssstikFetch(sourceUrl, token));

    if (files) return files;
  }

  return null;
}


async function fetchTikTokVideo(videoId, cookie, sourceUrl) {
  // With these parameters TikTok's site returns the /aweme/v1/play/ endpoint,
  // which is the only one that usually comes without a block.
  const rich = (value) => {
    try {
      const url = new URL(value);
      url.searchParams.set("is_from_webapp", "1");
      url.searchParams.set("sender_device", "pc");
      url.searchParams.set("from", "web");
      return url.href;
    } catch {
      return value;
    }
  };

  const sources = [
    // The mobile version is the only one that always answers, with any
    // User-Agent and also on photo posts: it always goes first.
    { url: `https://m.tiktok.com/v/${videoId}?is_from_webapp=1&sender_device=pc&from=web` },
    // The user's own link with its parameters is the most complete source.
    /* The link as pasted is fetched with the cookie jar, so this is the line that
       decides where `TT_COOKIE` goes. Only TikTok itself, checked by host. */
    ...(sourceUrl && platformOf(sourceUrl) === "tiktok" ? [{ url: rich(sourceUrl) }, { url: sourceUrl }] : []),
    { url: `https://m.tiktok.com/v/${videoId}` },
    { url: `https://www.tiktok.com/embed/v2/${videoId}` },
    { url: `https://www.tiktok.com/@i/${videoId}?is_from_webapp=1&sender_device=pc&from=web` },
    { url: `https://www.tiktok.com/@i/${videoId}?_r=1` },
  ];

  const pattern = /https:\/\/[a-z0-9.\-]+\/(?:video|api\/[^"]+)\/tos\/[^"'\s<>\\]{10,220}/g;
  const scraped = new Set();
  const jar = cookieJar();
  let item = null;
  let playable = null;
  let fetches = 0;

  const agents = TIKTOK_BROWSER_AGENTS;

  for (const source of sources) {
    for (const agent of agents) {
      if (fetches >= 12 || playable || (item && scraped.size >= 6)) break;

      fetches += 1;

      const session = jar.header();

      const page = await fetchPage(source.url, {
        "User-Agent": agent,
        "Accept-Language": "en-US,en;q=0.9",
        Referer: TIKTOK_REFERER,
        ...(cookie || session ? { Cookie: cookie ?? session } : {}),
      });

      jar.absorb(page.headers);

      if (!page.ok) continue;

      const html = page.text;

      if (!/playAddr|downloadAddr|imagePost/.test(html)) continue;

      for (const match of html.matchAll(pattern)) scraped.add(match[0]);

      const found = extractTikTokVideo(html, videoId);

      if (found) {
        item ??= found;

        for (const value of walkStrings(found)) {
          if (/\/aweme\/v1\/play\//.test(value)) playable = value;
        }
      }
    }
  }

  if (!item) return null;

  return {
    video: item,
    referer: TIKTOK_REFERER,
    // The /aweme/v1/play/ endpoint is the least restrictive: it always
    // goes first.
    media: [...new Set([...(playable ? [playable] : []), ...scraped])],
  };
}


function extractTikTokVideo(html, videoId) {
  const payloads = parseJsonScripts(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");

  for (const data of payloads) {
    const scopes = data?.__DEFAULT_SCOPE__ ?? {};

    for (const scope of ["webapp.video-detail", "webapp.reflow.video.detail"]) {
      const item = scopes?.[scope]?.itemInfo?.itemStruct;

      if (String(item?.id) === videoId && rankTikTokNode(item)) return item;
    }
  }

  for (const data of payloads) {
    const item = findTikTokItem(data, videoId);

    if (item) return item;
  }

  for (const scriptId of ["api-data", "SIGI_STATE", "__NEXT_DATA__"]) {
    for (const data of parseJsonScripts(html, scriptId)) {
      const item = findTikTokItem(data, videoId);

      if (item) return item;
    }
  }

  return null;
}


function walkJson(root) {
  const stack = [root];
  const seen = new WeakSet();
  const out = [];

  while (stack.length) {
    const value = stack.pop();

    if (!value || typeof value !== "object" || seen.has(value)) continue;

    seen.add(value);
    out.push(value);

    for (const child of Object.values(value)) stack.push(child);
  }

  return out;
}


function extractTikTokMedia(item, extraUrls) {
  const images = item.imagePost?.images ?? [];

  if (images.length) {
    return images.flatMap((image) => {
      const source = image.imageURL;
      const list = typeof source === "string"
        ? [source]
        : Array.isArray(source?.urlList) ? source.urlList : [];

      return list.length ? [{ media: list, isVideo: false, kind: "image" }] : [];
    });
  }

  const video = item.video ?? item;
  const variants = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
  const selectedVariant = variants
    .filter((variant) => /h264|avc1/i.test(
      `${variant.CodecType ?? ""} ${variant.PlayAddr?.UrlKey ?? ""}`,
    ))
    .sort((a, b) => Number(b.Bitrate ?? 0) - Number(a.Bitrate ?? 0))[0]
    ?? variants.sort((a, b) => {
      const areaA = Number(a.PlayAddr?.Width ?? 0) * Number(a.PlayAddr?.Height ?? 0);
      const areaB = Number(b.PlayAddr?.Width ?? 0) * Number(b.PlayAddr?.Height ?? 0);
      return areaB - areaA || Number(b.Bitrate ?? 0) - Number(a.Bitrate ?? 0);
    })[0];

  const media = [
    ...(selectedVariant?.PlayAddr?.UrlList ?? []),
    video.downloadAddr,
    ...(video.PlayAddrStruct?.UrlList ?? []),
    video.playAddr,
    ...(extraUrls ?? []),
  ].filter((url, index, all) => typeof url === "string" && url.startsWith("http") && all.indexOf(url) === index)
    // The site's own /aweme/v1/play/ endpoint is the least restrictive.
    .sort((a, b) => Number(/\/aweme\/v1\/play\//.test(b)) - Number(/\/aweme\/v1\/play\//.test(a)));

  // Any string that is a URL inside the post: this also catches the playback
  // endpoints (/aweme/v1/play/) that are not in playAddr.
  for (const node of walkJson(item)) {
    const values = Array.isArray(node?.urlList) ? node.urlList : [node];

    for (const value of values) {
      if (typeof value !== "string") continue;

      // TikTok sometimes leaves the path relative: /aweme/v1/play/?faid=…
      const url = value.startsWith("//")
        ? `https:${value}`
        : value.startsWith("/aweme/") || value.startsWith("/video/")
          ? `https://www.tiktok.com${value}`
          : /^https?:\/\//.test(value)
            ? value
            : null;

      if (url && media.indexOf(url) === -1) media.push(url);
    }
  }

  const files = [];

  if (media.length) files.push({ media, isVideo: true, kind: "video" });

  const cover = [video.cover, video.originCover, video.dynamicCover]
    .find((value) => typeof value === "string" && value.startsWith("http"));

  if (cover) {
    files.push({ media: [cover], isVideo: false, kind: "image" });
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
 * The short link is expanded first, because it is the only shape that does not
 * carry the video id: everything else here works from the id, and without this
 * a `vt.tiktok.com` link would look like no platform at all.
 */
export async function detectTikTok(input) {
  const source = await expandTikTokUrl(input);
  const videoId = extractTikTokVideoId(source);

  if (!videoId) return null;

  /* ssstik.io goes first. Its CDN does not ask for a Referer, and TikTok's
     direct link answers 403 without one, so what it has reaches where ours does
     not. In exchange it has a limit of one request every thirty seconds per IP
     that gives no warning —it returns an empty 200— so it will almost always
     be used up and ours takes over, which is slower but never runs out.
     When ssstik answers there are two files, the video and the audio; ours also
     adds the cover photo. */
  const thirdParty = await fetchTikTokSSSTIK(source);

  if (thirdParty) {
    return {
      files: thirdParty,
      prefix: `tiktok-${videoId}`,
      referer: "https://www.tiktok.com/",
    };
  }

  const found = await fetchTikTokVideo(videoId, cookieValue("TT_COOKIE"), source);

  if (!found) throw explain("The public TikTok video was not found");

  return {
    files: extractTikTokMedia(found.video, found.media),
    prefix: `tiktok-${videoId}`,
    referer: found.referer,
  };
}
