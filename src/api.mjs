/**
 * Core of the API. Returns standard `Response` objects and touches neither
 * `node:http` nor Node streams, so the same code runs in the Node server
 * (`tools/serve.mjs`) and in the Cloudflare Worker (`worker.js`).
 *
 * In Workers this is not a detail: there requests come in through `fetch` and
 * the response goes out as a `Response`. Conversely, the media proxy is shorter
 * here than in Node, because the upstream body is passed through as-is instead
 * of being copied chunk by chunk.
 */import {
  MOBILE_USER_AGENT,
  withStatus,
  explain,
  fetchTimed,
  mediaExtension,
  mediaName,
  bestVariant,
  openMediaResponse,
  resetSubrequests,
  setSecrets,
  subrequestsLeft,
} from "./core.mjs";
import {
  detectSource,
  getYouTubeMedia,
  getYouTubePlaylist,
  resolveMedia,
} from "./dispatch.mjs";
import { isPublic, universal } from "./universal.mjs";

/* `worker-entry.js` asks this module for `setSecrets`, not `core.mjs`, because
   this one already knows the shape of the API. Importing it is not enough: an
   `import` is a link, not an export, so the file next door was a module that
   did not load at all. And nothing saw it, because the build flattens every
   file into one and the flattened result comes out just the same: the bug was
   in the code, not in the Worker. */
export { setSecrets };

/* ==========================================================================
   Utilities
   ========================================================================== */

export function fail(message, status = 500) {
  return Object.assign(new Error(message), { status });
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** A request header, wherever it came from. */
function header(request, name) {
  return request?.headers?.get?.(name) ?? "";
}

const KEEP_PARAMS = {
  youtube: ["v", "list"],
  pornhub: ["viewkey"],
  facebook: ["v", "story_fbid"],
  x: ["s", "t"],
};

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Size already in readable units: the frontend formats nothing. */
function formatSize(bytes) {
  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) return "";

  const unit = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** unit;

  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: unit ? 1 : 0 }).format(amount)} ${UNITS[unit]}`;
}

/* The `type` field any API client sees. English for the same reason the error
   messages are: this is text coming out of the Worker, and the Worker speaks
   English. The browser has its own map keyed by `kind` —a closed set of three
   values that does not depend on language— so this does not change it. */
const KIND_LABELS = { video: "Video", audio: "Audio", image: "Image" };

/**
 * Platforms whose CDN refuses playback when another page requests it: without
 * the right `Referer` they answer 403, so the video and audio are served from
 * here. This does not affect downloading, which already went through the proxy.
 */
const HOTLINKED = new Set(["tiktok", "instagram", "facebook", "snapchat", "x"]);

/** Site each CDN belongs to: the `Referer` they demand. */
const PLATFORM_SITE = {
  tiktok: "https://www.tiktok.com/",
  instagram: "https://www.instagram.com/",
  facebook: "https://www.facebook.com/",
  snapchat: "https://www.snapchat.com/",
  x: "https://x.com/",
  reddit: "https://www.reddit.com/",
};

const BRANDS = {
  snapchat: "Snapchat",
  dailymotion: "Dailymotion",
  bluesky: "Bluesky",
  ok: "OK",
  x: "X",
  facebook: "Facebook",
  threads: "Threads",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  pornhub: "Pornhub",
  kwai: "Kwai",
  spotify: "Spotify",
  reddit: "Reddit",
  soundcloud: "SoundCloud",
};

const KIND_TYPES = {
  video: /^video\//i,
  image: /^image\//i,
  audio: /^(audio|video)\//i,
};

const CONTENT_TYPES = {
  mp4: "video/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
};

const YOUTUBE_REFERER = "https://www.youtube.com/";
const PLAYLIST_EAGER = 12;

/* ==========================================================================
   URLs: cleaning, cache and checking
   ========================================================================== */

/** Strips the link down to only what identifies the content. */
function canonicalSource(value, platform) {
  try {
    const url = new URL(value);
    const keep = KEEP_PARAMS[platform] ?? [];

    for (const key of [...url.searchParams.keys()]) {
      if (!keep.includes(key)) url.searchParams.delete(key);
    }

    url.protocol = "https:";
    url.hash = "";
    url.username = "";
    url.password = "";
    url.host = url.host.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";

    return url.href;
  } catch {
    return value;
  }
}

function sourceFrom(input) {
  const platform = detectSource(input);
  const source = platform ? canonicalSource(String(input).trim(), platform) : String(input).trim();

  return { platform, source };
}

const CACHE_TTL = 300000;
const CACHE_MAX = 200;
const cache = new Map();

/**
 * Failures kept for a moment, plus the last good result for each link.
 *
 * Failures are stored because otherwise a YouTube 429 —or any other— becomes a
 * fresh request to the platform every time someone asks for it. With a request
 * limit in play that is not a failure: it is a way to make the limit worse.
 * Storing the failure for thirty seconds means whoever arrives in that window
 * gets the same error without spending an extra call.
 *
 * The last good result is stored separately and for much longer, so it can be
 * fallen back on when the platform errors. A link that resolved fine two
 * minutes ago is still the same link, even if the platform answers now.
 */
const FAIL_TTL = 30000;
const STALE_TTL = 30 * 60 * 1000;

const failures = new Map();
const lastGood = new Map();

/* Whether a resolver failure means "this is not one of ours" rather than "one of
   ours failed". Matching on the message is the same bargain `BAD_REQUEST` makes,
   but the alternative is worse: without this the universal extractor is only
   reachable from `handleResolve`, and the two routes then disagree about which
   links exist. */
const WITHOUT_PLATFORM = /could not be identified|is not a supported platform|unknown platform/i;

function isWithoutPlatform(error) {
  return WITHOUT_PLATFORM.test(String(error?.message ?? ""));
}

async function resolved(source) {
  const hit = cache.get(source);

  if (hit && hit.until > Date.now()) {
    cache.delete(source);
    cache.set(source, hit);
    return hit.value;
  }

  const failed = failures.get(source);

  if (failed && failed.until > Date.now()) {
    const stale = lastGood.get(source);

    /* If it resolved fine recently, that is worth more than the error now:
       links on these platforms expire in days, not minutes. */
    if (stale && stale.until > Date.now()) return stale.value;

    throw failed.error;
  }

  failures.delete(source);

  let value;

  try {
    value = await resolveMedia(source);
  } catch (error) {
    /* The link is not from a known platform. The universal extractor gets a turn
       here for the same reason `handleResolve` gives it one, and it is the last
       resort rather than a shortcut: if the site declares nothing, its error is
       what is returned.

       This was missing, and it made the universal half of the product unusable:
       `/api/resolve` showed a real card with a Download button, and pressing it
       asked `resolveMedia` directly, which throws "That link could not be
       identified" for any host outside the platform table. Resolve worked,
       download answered 500, and the visitor was told the link they had just seen
       resolved could not be read. */
    if (isWithoutPlatform(error)) {
      try {
        const encontrado = await universal(source);

        /* `universal()` already brings its own `referer`, which is the page the files
           were taken from: almost every open-web CDN only serves requests that
           come from its own page, so putting a fake referer in place makes all
           four buttons fail. */
        if (encontrado.files?.length) {
          value = {
            files: encontrado.files,
            prefix: encontrado.prefix,
            referer: encontrado.referer,
          };
        } else {
          throw error;
        }
      } catch (fallback) {
        if (fallback === error) throw error;
        failures.set(source, { error: fallback, until: Date.now() + FAIL_TTL });
        throw fallback;
      }
    } else {
      failures.set(source, { error, until: Date.now() + FAIL_TTL });
    }

    if (!value) {
      const stale = lastGood.get(source);

      if (stale && stale.until > Date.now()) return stale.value;

      throw error;
    }
  }

  cache.set(source, { value, until: Date.now() + CACHE_TTL });
  lastGood.set(source, { value, until: Date.now() + STALE_TTL });

  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  while (lastGood.size > CACHE_MAX) lastGood.delete(lastGood.keys().next().value);
  while (failures.size > CACHE_MAX) failures.delete(failures.keys().next().value);

  return value;
}

/**
 * Finds the first URL that really serves the file and measures its size on the
 * way. If the first one redirects, has expired or returns HTML, it moves on to
 * the next.
 */
async function probeMedia(file, referer) {
  const headers = {
    "User-Agent": MOBILE_USER_AGENT,
    Referer: referer,
    Range: "bytes=0-0",
  };
  /* The expected content type. By default, the one for the file's category. But
     the universal extractor cannot be strict: a site may serve an `.mkv` as
     `application/octet-stream` and another an `.mp4` as `binary/octet-stream`,
     and requiring `video/` strictly drops files that are really there. That is
     why it can bring its own `accept`. */
  const expected = file.accept
    ? new RegExp(file.accept, "i")
    : KIND_TYPES[file.kind];

  /* Three attempts, and only while there is budget left. It used to be eight,
     unchecked: a YouTube playlist with several videos measured burned through
     the entire free-plan allowance halfway down the list. */
  const attempts = file.media.slice(0, Math.max(1, Math.min(3, subrequestsLeft() - 1)));

  for (const url of attempts) {
    try {
      /* `fetchTimed`, not bare `fetch`: probing also goes out to the internet
         and also counts as a subrequest. With direct `fetch`, the measured size
         was leaving the budget unnoticed. */
      const response = await fetchTimed(url, { headers, redirect: "follow" }, 6000);
      const type = response.headers.get("content-type") ?? "";

      if (!response.ok || !response.body || (expected && !expected.test(type))) {
        await response.body?.cancel();
        continue;
      }

      const size = Number(
        response.headers.get("content-range")?.split("/")[1]
        ?? response.headers.get("content-length")
        ?? 0,
      );

      await response.body?.cancel();

      if (size <= 1024) continue;

      return { url: response.url || url, size };
    } catch {}
  }

  return null;
}

/* ==========================================================================
   YouTube playlists
   ========================================================================== */

function safeName(text) {
  return String(text ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "video";
}

/**
 * Download name for files with accented letters, ñ or emojis. The plain
 * `filename` only takes ASCII, so a trimmed version goes there and the real
 * name travels in `filename*`, which is what current browsers read (RFC 6266).
 */
function contentDisposition(filename) {
  const plain = filename.replace(/[^\x20-\x7e]+/g, " ").replace(/\s+/g, " ").trim() || "file";
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/**
 * The origin the Worker's addresses are built from.
 *
 * It comes from the request itself, not a constant: the same Worker serves
 * `downloader.pages.dev` and whatever custom domain is put in front of it, and a
 * hand-built address would end up pointing at the wrong site.
 */
function onOrigin(base, paths) {
  return `${base}${paths}`;
}

function mediaPath(videoId, base) {
  return onOrigin(base, `/api/media?${new URLSearchParams({ id: videoId })}`);
}

const mediaCache = new Map();

/** A single YouTube video, with its direct URL already checked. */
async function youtubeVideoMedia(videoId) {
  const cached = mediaCache.get(videoId);

  if (cached && cached.until > Date.now()) return cached;

  const { files } = await getYouTubeMedia(videoId);
  const video = files.find((file) => file.kind === "video") ?? files[0];
  const probe = await probeMedia(video, YOUTUBE_REFERER);
  const hit = { url: probe?.url ?? video.media[0], size: probe?.size ?? 0, until: Date.now() + CACHE_TTL };

  mediaCache.set(videoId, hit);

  return hit;
}

/**
 * A playlist's videos: the first ones measured, the rest on demand.
 *
 * Measuring one video takes several requests (the page, the player and up to
 * three size probes). With a long playlist, measuring the first twelve blew
 * past the free plan's subrequest cap halfway through. Now it first works out how
 * many fit in the remaining budget and measures those, in parallel; the rest are
 * marked `lazy`: no size, but the player requests them as soon as one is
 * selected, and that request arrives on its own.
 */
async function youtubePlaylistItems(listId, base) {
  const { videos } = await getYouTubePlaylist(listId, 60);

  /* Six per video is a generous ceiling: page, player and probes. */
  const affordable = Math.max(1, Math.floor(subrequestsLeft() / 6));
  const eager = await Promise.all(
    videos.slice(0, Math.min(PLAYLIST_EAGER, affordable)).map((video) =>
      youtubeVideoMedia(video.id).catch(() => null)),
  );

  return videos.map((video, index) => {
    const hit = eager[index] ?? null;
    const lazy = !hit?.url;

    return {
      index,
      kind: "video",
      type: KIND_LABELS.video,
      brand: BRANDS.youtube,
      extension: "MP4",
      title: video.title,
      name: `${safeName(video.title)}.mp4`,
      size: formatSize(hit?.size),
      seconds: video.seconds,
      lazy,
      /* Here `media` is direct when it has already been measured, and `null` when
         the item is one of those left unmeasured. The endpoint is not put in its
         place, because then it would stop being the direct URL, which is exactly
         what was asked for.

         A `null` here is not a hole: the client falls back to `proxy` when
         `media` is absent, and `/api/media?id=…` resolves the video and replies
         with a 302 to its direct URL, so as soon as it is requested a real link
         comes out. */
      media: hit?.url ?? null,
      ...(lazy ? { proxy: mediaPath(video.id, base) } : {}),
    };
  });
}

/**
 * The playlist ID of a YouTube link, or `null` if it has none.
 *
 * `RD` is left out on purpose. It is the prefix of the "radio" —the automatic
 * playlist YouTube builds from whatever comes after the video— and it is not a
 * real playlist: it has no page, it cannot be queried, and requesting it errors.
 * A `?v=…&list=RD…` link means "this video and whatever comes next", so what is
 * wanted is the video, not a playlist that does not exist.
 *
 * The prefixes that are real playlists: `PL` (user), `UU` (subscriptions),
 * `OL` and `FL` (albums and favourites) and `TL` (the account's own topical
 * lists).
 */
function extractYouTubeList(source) {
  try {
    const parsed = new URL(source);
    const list = parsed.searchParams.get("list");

    return list && /^(?:PL|UU|OL|FL|TL)/.test(list) ? list : null;
  } catch {
    return null;
  }
}

/* ==========================================================================
   HLS: segments MPEG-TS encadenados
   ========================================================================== */

/** Dailymotion and Bluesky demand their own origin on the segments. */
function refererFor(playlist) {
  return /dailymotion\.com/i.test(playlist) ? "https://www.dailymotion.com/" : "https://bsky.app/";
}

/**
 * Playlist: returns the segments and, when the format is fMP4 (like Reddit's),
 * the init segment that precedes them. Without that `init` a fragmented MP4 does
 * not play, so it cannot be ignored.
 *
 * Reddit also uses `EXT-X-BYTERANGE`: the 50 chunks are not 50 files but slices
 * of a single 53 MB mp4. Downloading the whole file per chunk makes a 200 s video
 * weigh 371 MB instead of 53, so the range is honoured.
 */
async function hlsSegments(url, depth = 0) {
  const response = await fetchTimed(url, { headers: { "User-Agent": MOBILE_USER_AGENT } });

  if (!response.ok) throw withStatus(new Error(`The video responded ${response.status}`), response.status);

  const text = await response.text();
  const lines = text.split("\n").map((line) => line.trim());

  if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
    if (depth > 2) throw explain("The playlist is nested too deeply");

    /* `bestVariant` instead of a second copy of the same decision.

       The copy that was here read `BANDWIDTH` alone, so it ignored `CODECS` and
       ignored the `RESOLUTION` that the other extractor already ranks on, and it
       found the URI with "the first line after this one that is not a comment" —
       which steps over an `#EXT-X-I-FRAME-STREAM-INF` and takes the next variant's
       address, so a master with an I-frame track resolved to whatever followed it.

       Ranking in one place is also the only way the fix to that ranking reaches
       both callers. One rule, one place to be wrong in. */
    const best = bestVariant(lines.join("\n"));

    if (best) return hlsSegments(new URL(best, url).href, depth + 1);
  }

  const part = (spec) => {
    const match = /(\d+)(?:@(\d+))?/.exec(spec ?? "");
    return match ? { start: Number(match[2] ?? 0), length: Number(match[1]) } : null;
  };

  /* Every address below comes out of the playlist body, not out of the parameter.

     The guard on the request only looked at the playlist URL the caller chose.
     The playlist is a document the caller also chose, and it decides where the
     rest of the request goes: `/api/media?url=…/anything.m3u8` whose body lists
     `http://127.0.0.1:…/` as a segment came back with the bytes of whatever that
     address served. On Cloudflare `fetch` only reaches the internet, so the damage
     is capped there; on a laptop running this same file with no gateway in front
     it reads a router, a dev database or a `.env`.

     So the rule is applied to every address the playlist produced, and a segment
     that does not pass is not a segment. The whole playlist is rejected rather
     than the odd entry: a real CDN does not mix, and a playlist that does is
     trying something. */
  const absoluteUrl = (target) => {
    const href = new URL(target, url).href;

    if (!isPublic(href)) {
      throw explain("That playlist points at an address that is not a public one");
    }

    return href;
  };

  const mapLine = lines.find((line) => line.startsWith("#EXT-X-MAP:")) ?? "";
  const mapUri = /URI="([^"]+)"/.exec(mapLine)?.[1];
  const mapRange = part(/BYTERANGE="([^"]+)"/.exec(mapLine)?.[1]);
  const segments = [];
  let cursor = 0;

  lines.forEach((line, index) => {
    if (!line.startsWith("#EXTINF")) return;

    const after = lines.slice(index + 1);
    const rangeSpec = after.find((value) => value.startsWith("#EXT-X-BYTERANGE:"));
    const target = after.find((value) => value && !value.startsWith("#"));

    if (!target) return;

    const href = absoluteUrl(target);
    const range = part(rangeSpec?.split(":")[1]);

    if (range) {
      // A BYTERANGE without "@" continues where the previous one ended.
      const start = Number(/@(\d+)/.exec(rangeSpec ?? "")?.[1] ?? cursor);

      cursor = start + range.length;
      segments.push({ url: href, start, length: range.length });
    } else {
      segments.push({ url: href });
    }
  });

  const initUrl = mapUri ? absoluteUrl(mapUri) : null;

  return {
    segments,
    init: initUrl ? { url: initUrl, ...(mapRange ?? {}) } : null,
    /* `EXT-X-MAP` only appears in fragmented MP4, and it is the reliable signal.
       It used to be guessed from whether the playlist URL carried "AUDIO_", which
       confused Reddit's video with MPEG-TS and served a real MP4 as `video/mp2t`:
       the download name said `.mp4` and the content type said `video/mp2t`. */
    fmp4: Boolean(mapUri),
    single: singleFile(segments, initUrl),
  };
}

/**
 * Reddit's special case: the 50 chunks are not 50 files, they are 50
 * `EXT-X-BYTERANGE` slices of the same MP4, one after another with no gaps. The
 * whole file is already a playable MP4, so instead of asking for 50 ranges it
 * asks for **one** spanning all of them.
 *
 * This is not a minor optimisation: 50 requests is exactly the free plan's cap,
 * and with the init it is 51, one over. Cloudflare cut the whole request and the
 * user saw a video that would not load, with no explanation.
 */
function singleFile(segments, initUrl) {
  if (segments.length < 4) return null;

  const [first] = segments;

  /* All chunks have to come from the same file and be consecutive. */
  if (!first?.url || segments.some((segment) => segment.url !== first.url || segment.length == null)) {
    return null;
  }

  const init = initUrl === first.url ? 0 : null;
  let cursor = first.start;

  for (const segment of segments) {
    if (segment.start !== cursor) return null;
    cursor = segment.start + segment.length;
  }

  /* With the init inside the same file, it starts at 0. If the init were a
     different file, it cannot be merged into a single read.
     Mind comparing against `null` and not against `falsy`: here the good value
     is 0, and an `if (!init)` would discard exactly the case being handled. */
  if (init === null) return null;

  return { url: first.url, start: init, end: cursor - 1 };
}

/** Chains the chunks into a single output stream. */
/**
 * Concatenates the segments into one stream.
 *
 * Each segment used to be read with a single `getReader().read()`, which returns
 * one chunk and no more — typically 16 KB. The rest of the segment was never read
 * and the reader was dropped on the floor. Twenty segments of a 72-second video
 * came out as 320 KB, so every HLS download was a file that played for a second
 * and then stopped. A reader has to be read until it says it is done.
 *
 * One chunk per `pull` on purpose: the whole segment is streamed, but the stream
 * never queues more than the consumer has asked for, so a slow download does not
 * accumulate the entire video in the isolate's memory.
 */
function concatStream(parts) {
  let index = 0;
  let reader = null;

  const nextPart = async () => {
    if (reader) return reader;

    while (index < parts.length) {
      const part = parts[index++];
      const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: refererFor(part.url) };

      if (part.length != null) {
        headers.Range = `bytes=${part.start}-${part.start + part.length - 1}`;
      }

      const chunk = await fetchTimed(part.url, { headers });

      if (!chunk.ok || !chunk.body) {
        /* A segment that will not come is skipped rather than fatal: one gap in a
           VOD stream stutters, and losing the whole file over one is worse. The
           body is cancelled so the connection is not left open. */
        await chunk.body?.cancel().catch(() => {});
        continue;
      }

      reader = chunk.body.getReader();
      return reader;
    }

    return null;
  };

  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const current = await nextPart();

        if (!current) {
          controller.close();
          return;
        }

        const { done, value } = await current.read();

        if (done) {
          await current.cancel().catch(() => {});
          reader = null;
          continue;
        }

        if (value) controller.enqueue(value);
        return;
      }
    },

    async cancel() {
      await reader?.cancel().catch(() => {});
      reader = null;
    },
  });
}

/**
 * Serves an HLS. The extension, content type and name are decided **here**, not
 * by the caller, because only whoever reads the playlist knows whether what comes
 * out is MPEG-TS or fragmented MP4. Each caller used to assume it and they
 * contradicted each other: Reddit's video download was named `.mp4` but served
 * as `video/mp2t`.
 *
 * `kind` only says whether the audio track or the video track is wanted.
 * `naming` carries the pieces of the name —prefix, position and label— so it
 * stays `reddit-1.mp4` instead of a contextless `video.mp4`.
 */
/**
 * An HLS item taken apart, ready for whoever wants it.
 *
 * It used to be folded into the route, which left the CLI with no way to reach
 * an HLS item at all: `openMediaResponse` refuses a `.m3u8` because its type is
 * not video, image or audio, so every Reddit video, every X video and everything
 * the universal extractor finds in a playlist was undownloadable from the
 * terminal while the API served it fine. Splitting it here means the route and
 * the CLI read the playlist the same way and cannot drift apart.
 *
 * `single` is the case where the "segments" are byte ranges of one MP4 rather
 * than separate chunks, which is what turns fifty requests into one.
 */
export async function hlsParts(url, kind, naming = null) {
  const { segments, init, fmp4, single } = await hlsSegments(url);

  if (!segments.length) throw explain("That video has no downloadable segments");

  const extension = fmp4 ? (kind === "audio" ? "m4a" : "mp4") : "ts";
  const contentType = fmp4 ? (kind === "audio" ? "audio/mp4" : "video/mp4") : "video/mp2t";
  const name = naming
    ? mediaName(naming.prefix, extension, naming.index, naming.total, naming.label)
    : `${kind}.${extension}`;

  return { parts: init ? [init, ...segments] : segments, single, extension, contentType, name };
}

/** One part of a playlist, as a `Response`. Shared by the route and the CLI. */
export async function hlsPartResponse(part) {
  const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: refererFor(part.url) };

  if (part.length != null) headers.Range = `bytes=${part.start}-${part.start + part.length - 1}`;

  const response = await fetchTimed(part.url, { headers });

  if (!response.ok) throw withStatus(new Error(`The video responded ${response.status}`), response.status);

  return response;
}

async function streamHls(url, kind, naming = null) {
  const { parts, single, contentType, name } = await hlsParts(url, kind, naming);

  /* A single file: it is passed through whole instead of chaining 50 chunks. One
     request instead of fifty, and nothing is lost from the video. */
  if (single) return singleRange(single, name, contentType);

  /* More chunks remain than fit under the subrequest cap. It used to try anyway
     and the stream would die halfway with the browser having no idea why. Now it
     says so. */
  if (parts.length > subrequestsLeft()) {
    throw explain(
      `That video is split into ${parts.length} segments and the free plan only allows ${subrequestsLeft()} requests. `
      + "The paid plan, which allows 1000, is required.",
    );
  }

  return new Response(concatStream(parts), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(name),
      "Cache-Control": "no-store",
    },
  });
}

/** A single MP4 served in one request, honouring the requested range. */
async function singleRange({ url, start, end }, filename, contentType) {
  const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: refererFor(url), Range: `bytes=${start}-${end}` };
  const upstream = await fetchTimed(url, { headers });

  if (!upstream.ok) throw withStatus(new Error(`The video responded ${upstream.status}`), upstream.status);

  const out = {
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(filename),
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };

  for (const [key, name] of [["content-length", "Content-Length"], ["content-range", "Content-Range"]]) {
    const value = upstream.headers.get(key);

    if (value) out[name] = value;
  }

  return new Response(upstream.body, { status: 200, headers: out });
}

/**
 * Passes through a file its CDN will not load from outside, adding the
 * platform's `Referer`. The range is forwarded as-is: without it the video
 * cannot be seeked or show its duration.
 */
async function streamGuarded(target, platform, range) {
  const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: PLATFORM_SITE[platform] ?? refererFor(target) };

  if (range && /^bytes=/i.test(range)) headers.Range = range;

  const upstream = await fetchTimed(target, { headers });

  if (!upstream.ok && upstream.status !== 206) {
    throw withStatus(new Error(`The file responded ${upstream.status}`), upstream.status);
  }

  const out = {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  for (const [key, name] of [["content-length", "Content-Length"], ["content-range", "Content-Range"]]) {
    const value = upstream.headers.get(key);
    if (value) out[name] = value;
  }

  // The body is passed through as-is: in Node it used to have to be copied, here
  // it does not.
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: out });
}

/* ==========================================================================
   Short messages for the interface
   ========================================================================== */

/**
 * Platform errors are long and full of jargon ("HTTP 403", "blocked"), so they
 * are rewritten into short text that makes sense in the interface. But the ones
 * the resolver itself flags as explained are already written to be read by the
 * user: those pass through unchanged, because their whole value is in saying what
 * happened and what to do.
 */
function humanize(error) {
  if (error?.user) return String(error.message);

  const text = String(error?.message ?? error ?? "");

  /* These patterns were written against the messages the extractors produce, so
     they have to
     be in English like the messages are. Translating the messages without
     touching the patterns makes the new text match none of them and everything
     falls through to the safety net. */
  if (/not public|has no videos/i.test(text)) return "that playlist is not public";
  if (/signed[- ]in|session|cookie|private/i.test(text)) return "that content is not public";
  /* The block comes BEFORE the "did not respond", for the same reason the page
     does it in that order: every message of the form "X responded 403" carries
     the word "respond", so the generic pattern ate it and a CDN refusing the
     download was reported as the platform being down. Same for 401 and 451.

     What tells them apart is the status, so it is tested explicitly instead of
     leaving it to whichever word comes first. */
  if (/\b(?:401|403|451)\b/.test(text) || /block(?:ed)? the download|block screen|age gate/i.test(text)) {
    return "this platform won't let you download from this network";
  }

  /* A rate limit is not the platform being down, and saying so sends people to look
     at the wrong thing. It is also the one status the user can do something about
     — come back later — so it is worth saying. This used to fall through to the
     "did not respond" rule below, because the extractor's message is "The video
     responded 429" and that contains "respond". */
  if (/\b429\b/.test(text) || /rate.?limit/i.test(text)) {
    return "this platform is rate-limiting this network; try again in a few minutes";
  }

  if (/respond|configuration/i.test(text)) return "the platform did not respond";
  return "that link couldn't be read";
}

/* A badly pasted link or one from an unlisted platform is the caller's fault,
   not a server failure. It used to come back as 500, which not only lies but
   also inflates the Worker's error stats. */
const BAD_REQUEST = /address is not valid|only http or https|No downloadable files were found|the request budget ran out/i;

export function statusFor(error) {
  if (error?.status) return error.status;

  /* An error flagged with `explain()` is by definition the caller's fault: a bad
     link, a list that does not exist, an address that is not valid. With that,
     there is no need to guess from the text, which is what `BAD_REQUEST` did and
     what left the universal extractor returning 500 for phrasing the message
     differently. `BAD_REQUEST` stays for errors that are not flagged. */
  if (error?.user) return 400;

  return BAD_REQUEST.test(String(error?.message ?? "")) ? 400 : 500;
}

/* ==========================================================================
   Routes
   ========================================================================== */

/**
 * Turns the files the resolver gives into the items the page sees.
 *
 * It lives on its own because two routes use it: the normal one for a single
 * link, and the fallback when a link carries both a list and a video and the
 * list could not be read.
 */
function describeItems(files, probes, prefix, platform, base) {
  const items = files.map((file, index) => {
    const kind = file.kind ?? (file.isVideo ? "video" : "image");
    const probe = probes[index];
    /* A playlist is never handed to the browser as a file: it is segments the
     browser has to request one at a time, and it cannot do that with our
     `Referer`. The flag comes from the extractor; see the note on the download
     branch for why the extension is not tested. */
    const live = Boolean(file.hls);
    const direct = probe?.url ?? file.media[0];
    /* `media` is ALWAYS the direct URL, which is what was asked for: the browser
       goes straight to the file without passing through here. What it cannot do
       is the CDN of five platforms, which answers 403 without seeing its site's
       `Referer`, and HLS, which is segments the browser cannot request one by
       one. That is not fixed by returning something else in `media`, because then
       `media` stops being the direct URL; it is fixed by leaving the endpoint in
       `proxy` so the client falls back to it when the direct one fails. */
    /* `file.directo` is the exception: some URLs from platforms in the list do
       serve on their own, because their CDN does not demand the Referer. Sending
       them through the proxy would spend a subrequest and the Worker's bandwidth
       for exactly the same result. */
    const proxy = live
      ? onOrigin(base, `/api/media?${new URLSearchParams({ url: file.media[0], kind })}`)
      : !live && !file.directo && HOTLINKED.has(platform) && file.kind !== "image"
        ? onOrigin(base, `/api/media?${new URLSearchParams({ url: direct, ref: platform })}`)
        : null;
    const extension = live ? (file.fmp4 ? file.extension ?? "mp4" : "ts") : mediaExtension(file, direct, probe?.type ?? "");

    return {
      index,
      kind,
      type: extension === "m3u8" ? "HLS" : KIND_LABELS[kind] ?? "File",
      brand: BRANDS[platform] ?? platform,
      extension: extension.toUpperCase(),
      name: mediaName(prefix, extension, index, files.length, file.label),
      // Short card text. Only platforms that return several named files send
      // this, like Spotify playlists.
      ...(file.title ? { title: file.title } : {}),
      size: formatSize(probe?.size),
      /* The direct URL, already verified with a probe. It is the only thing that
         goes in `media`, so that API consumers do not have to come through here
         or know anything about the Worker. */
      media: direct,
      /* The endpoint, only in the two cases where the direct URL does not work
         on its own. It is separate and optional: if it is absent, `media` is
         good. */
      ...(proxy ? { proxy } : {}),
    };
  });

  // Audio player background: the first image the platform provides. Nearly all
  // of them push it as a separate item of kind "image"; the resolver already
  // hangs it off the file where it has it to hand (Spotify). If there is none,
  // the audio goes without a photo and the player falls back to the box colour.
  const firstImage = items.find((item) => item.kind === "image")?.media ?? null;

  for (const [position, item] of items.entries()) {
    if (item.kind !== "audio") continue;
    const cover = files[position]?.cover ?? firstImage;
    if (cover) item.cover = cover;
  }

  return items;
}

/** Resolves a lone link and returns it with its items already measured. */
async function describeOneLink(source, platform, base) {
  const { files, prefix, referer } = await resolved(source);
  const probes = await Promise.all(
    files.map((file) => (file.hls ? Promise.resolve(null) : probeMedia(file, referer))),
  );

  /* Keyed, not spread loose: the caller spreads this into the response JSON, and
     a spread array would come out as `{0: …, 1: …}`. */
  return { items: describeItems(files, probes, prefix, platform, base) };
}

/** `/api/resolve?url=`: lists what is behind the link. */
export async function handleResolve(request, url) {
  const { platform, source } = sourceFrom(url.searchParams.get("url") ?? "");
  /* This Worker's origin on this request. Built by hand with the dev domain it
     would stay pointing at localhost in production, and built from a constant it
     would stay on pages.dev once a custom domain is put in front. */
  const base = url.origin;
  const listId = platform === "youtube" ? extractYouTubeList(source) : null;

  /* With `?v=…&list=…` there are two things in the link: the video and the list.
     If the list cannot be read —it is private, it was deleted, or the prefix is
     not a real list— the video is not thrown away with it: the link is still
     valid for that video, and that is what the person pasted. It falls through
     to the normal single-link route and the list failure is left in `warning`, so
     it is not lost but does not get in the way. */
  if (listId) {
    try {
      const items = await youtubePlaylistItems(listId, base);

      return json({
        source,
        platform,
        playlist: { listId, total: items.length, pending: items.filter((item) => item.lazy).length },
        items,
      });
    } catch (error) {
      return json({
        source,
        platform,
        warning: humanize(error),
        ...(await describeOneLink(source, platform, base)),
      });
    }
  }

  /* The link is not from any known platform. Before giving up, the universal
     extractor is tried, which walks the page's HTML looking for where it declared
     its files. It is a last resort, not a shortcut: if the site declares nothing,
     its error is returned and that is that.
     `platform` becomes `web` so the cards have a brand and the client is not
     left with a `null` it does not know how to draw. */
  if (!platform) {
    const encontrado = await universal(source);
    const { files, prefix, referer } = encontrado;
    const probes = await Promise.all(
      files.map((file) => (file.hls ? Promise.resolve(null) : probeMedia(file, referer))),
    );

    return json({
      source,
      platform: "web",
      universal: { found: encontrado.found, truncated: encontrado.truncated },
      /* Keyed, not spread loose: `describeItems` returns an array and spreading
         it would come out as `{"0": …, "1": …}`. */
      items: describeItems(files, probes, prefix, "web", base),
    });
  }

  return json({ source, platform, ...(await describeOneLink(source, platform, base)) });
}

/** `/api/media`: serves the file with the `Referer` its CDN demands. */
export async function handleMedia(request, url) {
  const target = url.searchParams.get("url") ?? "";
  const guarded = url.searchParams.get("ref") ?? "";
  const videoId = url.searchParams.get("id") ?? "";

  /* Which branch runs is decided FIRST, and the filter goes with the branch that
     needs it.

     This used to read `hls` and `target` from the same parameter, so a request
     carrying only `?id=` had both empty, `isPublic("")` was false and the guard
     below answered 400 "That address is not valid" — before the `id` branch was
     ever reached. That branch is what `mediaPath()` builds for the `lazy` items of
     a YouTube playlist, so on-demand playlist downloads could not work: the item
     looked valid, the page pointed `src` at the proxy, and the answer was always
     400. Reachable code, and it had never run.

     The `id` branch needs no filter because it fetches nothing the caller chose:
     it hands eleven characters to YouTube and gets a URL back. */
  if (!target) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return json({ error: "That video id is not valid" }, 400);
    }

    try {
      const { url: direct } = await youtubeVideoMedia(videoId);

      return new Response(null, {
        status: 302,
        headers: { Location: direct, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
      });
    } catch (error) {
      /* `statusFor` and not a literal: `withStatus()` exists to carry the status a
         platform answered with, and writing 502 here threw it away. A 429 from
         YouTube was reaching the client as "the platform did not respond" with a
         502, which is the opposite of what the extractor worked to say. */
      return json({ error: humanize(error) }, statusFor(error));
    }
  }

  /* The two branches left fetch a URL the caller chose, and neither used to look
     at what it pointed at. The `.m3u8` branch is the wider of the two: the playlist
     is read, and the segment addresses come out of its body, so one request could
     spend the whole subrequest budget on hosts the caller picked. That is abuse
     from Cloudflare, where `fetch` only reaches the internet, and it is SSRF from
     a laptop, where the same code runs with no gateway in the way and can read a
     router, a dev database or a `.env`.

     `isPublic()` is the filter the universal extractor already uses for its own
     fetches, so the rule is one rule and not two. */
  if (!isPublic(target)) {
    return json({ error: "That address is not valid" }, 400);
  }

  if (/\.m3u8/i.test(target)) {
    const kind = url.searchParams.get("kind") === "audio" ? "audio" : "video";

    try {
      return await streamHls(target, kind);
    } catch (error) {
      /* `statusFor` and not a literal: `withStatus()` exists to carry the status a
         platform answered with, and writing 502 here threw it away. A 429 from
         YouTube was reaching the client as "the platform did not respond" with a
         502, which is the opposite of what the extractor worked to say. */
      return json({ error: humanize(error) }, statusFor(error));
    }
  }

  // Platform hop: the file is passed through with the `Referer` its CDN asks
  // for. Ranges are supported so the player can seek inside it.
  if (guarded) {
    // The range arrives in the `Range` header, which is what the player sends.
    const range = header(request, "range");

    try {
      return await streamGuarded(target, guarded, range);
    } catch (error) {
      /* `statusFor` and not a literal: `withStatus()` exists to carry the status a
         platform answered with, and writing 502 here threw it away. A 429 from
         YouTube was reaching the client as "the platform did not respond" with a
         502, which is the opposite of what the extractor worked to say. */
      return json({ error: humanize(error) }, statusFor(error));
    }
  }

  return json({ error: "That address is not valid" }, 400);
}

/** `/api/download`: the link to the file with its real name. */
export async function handleDownload(_request, url) {
  const { source } = sourceFrom(url.searchParams.get("url") ?? "");
  const index = Number(url.searchParams.get("index") ?? 0) || 0;
  const { files, prefix, referer } = await resolved(source);
  const file = files[index] ?? files[0];

  /* The flag, not the file extension. The URL is whatever the platform's CDN
     served and it does not have to end in `.m3u8`: Vimeo's variant URLs carry a
     `pathsig` and no extension at all, so testing the extension sent that one
     down the plain-file branch and answered with a single segment named `.mp4`.
     `file.hls` is set by the extractor, which is what actually knows. */
  if (file.hls) {
    try {
      return await streamHls(file.media[0], file.kind === "audio" ? "audio" : "video", {
        prefix,
        index,
        total: files.length,
        label: file.label,
      });
    } catch (error) {
      /* `statusFor` and not a literal: `withStatus()` exists to carry the status a
         platform answered with, and writing 502 here threw it away. A 429 from
         YouTube was reaching the client as "the platform did not respond" with a
         502, which is the opposite of what the extractor worked to say. */
      return json({ error: humanize(error) }, statusFor(error));
    }
  }

  const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: referer };
  const upstream = await openMediaResponse(file, headers);
  const contentType = upstream.headers.get("content-type") ?? "";
  const extension = mediaExtension(file, upstream.url || file.media[0], contentType);
  const filename = mediaName(prefix, extension, index, files.length, file.label);
  const length = upstream.headers.get("content-length");

  const outHeaders = {
    "Content-Type": file.kind === "audio"
      ? CONTENT_TYPES[extension] ?? "audio/mp4"
      : contentType.split(";")[0] || CONTENT_TYPES[extension] || "application/octet-stream",
    "Content-Disposition": contentDisposition(filename),
    "Cache-Control": "no-store",
  };

  if (length) outHeaders["Content-Length"] = length;

  return new Response(upstream.body, { status: 200, headers: outHeaders });
}

export const ROUTES = {
  "/api/resolve": handleResolve,
  "/api/media": handleMedia,
  "/api/download": handleDownload,
};

/**
 * Single entry point for the API: zeroes the subrequest budget and dispatches.
 *
 * The reset has to be here and not inside each handler because the counter lives
 * in the module, and both the Worker's isolate and the Node process get reused:
 * without this call, a user's second request would inherit the first one's
 * spending and run out of headroom for no reason.
 */
export async function dispatch(request, url) {
  resetSubrequests();

  const handler = ROUTES[url.pathname];

  return handler ? await handler(request, url) : json({ error: "Not found" }, 404);
}
