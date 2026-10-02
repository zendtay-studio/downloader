/* YouTube. Everything that knows about this one site lives here and
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
  cookieHeader,
  explain,
  fetchPage,
  fetchTimed,
} from "../core.mjs";


/** Walks the InnerTube JSON and pulls the playlist's videos out. */
function pickPlaylistVideos(node, out = []) {
  if (!node || typeof node !== "object") return out;

  if (node.playlistVideoRenderer?.videoId) {
    const entry = node.playlistVideoRenderer;
    const title = entry.title?.runs?.[0]?.text ?? entry.title?.simpleText ?? "";

    if (title) {
      out.push({
        id: entry.videoId,
        title,
        seconds: Number(entry.lengthSeconds ?? entry.lengthText?.simpleText?.replace(/\D/g, "") ?? 0) || null,
      });
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") pickPlaylistVideos(value, out);
  }

  return out;
}


function pickContinuation(node, found = []) {
  if (!node || typeof node !== "object") return found;

  if (typeof node.token === "string" && node.token.length > 40) found.push(node.token);

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") pickContinuation(value, found);
  }

  return found;
}

/**
 * A playlist's videos, with their titles. InnerTube's IOS and ANDROID clients are
 * used because the desktop one no longer returns the playlist in the response.
 */


/**
 * A playlist's videos, with their titles. InnerTube's IOS and ANDROID clients are
 * used because the desktop one no longer returns the playlist in the response.
 */
export async function getYouTubePlaylist(listId, limit = 60) {
  /* With the public key there is no need to ask the page for anything. */
  let apiKey = innertubeKey;
  let refreshed = false;

  if (!apiKey) throw new Error("The YouTube configuration could not be fetched");

  const clients = [
    { id: 5, name: "IOS", version: "20.10.4", userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)", context: { deviceModel: "iPhone16,2", hl: "es", gl: "ES" } },
    { id: 3, name: "ANDROID", version: "20.10.38", userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip", context: { androidSdkVersion: 30, hl: "es", gl: "ES" } },
  ];

  const browse = async (body, client) => fetchTimed(
    `https://www.youtube.com/youtubei/v1/browse?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        "X-YouTube-Client-Name": String(client.id),
        "X-YouTube-Client-Version": client.version,
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/",
      },
      body: JSON.stringify({ context: { client: { clientName: client.name, clientVersion: client.version, ...client.context } }, ...body }),
    },
  );

  const videos = [];
  let payload = null;
  let client = clients[0];

  for (const candidate of clients) {
    try {
      const response = await browse({ browseId: `VL${listId}` }, candidate);

      if (!response.ok) continue;

      const data = await response.json();

      pickPlaylistVideos(data, videos);

      if (videos.length) {
        payload = data;
        client = candidate;
        break;
      }
    } catch (error) {
      /* Same as with the single video: if the key is what failed, the page is
         scraped once and it is retried. A 429 is not that: that is the IP. */
      if (!refreshed && keyLooksDead(error)) {
        refreshed = true;

        try {
          const found = await refreshInnertubeKey(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`);

          if (found) {
            apiKey = found;
            continue;
          }
        } catch {}
      }
    }
  }

  if (!videos.length) throw explain("That playlist is not public or has no videos");

  // Following pages via continuation token, up to the requested limit.
  const seen = new Set();
  let token = pickContinuation(payload)[0];

  while (token && videos.length < limit) {
    try {
      const response = await browse({ continuation: token }, client);

      if (!response.ok) break;

      const data = await response.json();
      const before = videos.length;

      pickPlaylistVideos(data, videos);

      const next = pickContinuation(data).find((value) => !seen.has(value));

      if (videos.length === before || !next) break;

      seen.add(token);
      token = next;
    } catch {
      break;
    }
  }

  const unique = [];
  const used = new Set();

  for (const video of videos) {
    if (used.has(video.id)) continue;

    used.add(video.id);
    unique.push(video);

    if (unique.length >= limit) break;
  }

  return { listId, videos: unique };
}


function extractYouTubeVideoId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const id = host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : ["youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com"].includes(host)
        ? url.pathname === "/watch"
          ? url.searchParams.get("v")
          : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]
        : null;

    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * InnerTube's public key: it ships in YouTube's own bundle and is the same for
 * everyone, so it can be used without scraping the video's page.
 *
 * This is not a shortcut: the `/watch` page is plain HTML, the first thing to
 * answer 429 when Cloudflare starts overdoing it, and reading it was one request
 * per resolve that served no other purpose. With the key to hand, resolving a
 * video is just the API calls.
 *
 * If that key ever stops working, it falls back to reading it from the page,
 * which is exactly the old path. That is why `innertubeKey` remembers where it
 * came from: the page is not scraped again on every request.
 */


/**
 * InnerTube's public key: it ships in YouTube's own bundle and is the same for
 * everyone, so it can be used without scraping the video's page.
 *
 * This is not a shortcut: the `/watch` page is plain HTML, the first thing to
 * answer 429 when Cloudflare starts overdoing it, and reading it was one request
 * per resolve that served no other purpose. With the key to hand, resolving a
 * video is just the API calls.
 *
 * If that key ever stops working, it falls back to reading it from the page,
 * which is exactly the old path. That is why `innertubeKey` remembers where it
 * came from: the page is not scraped again on every request.
 */
const INNERTUBE_PUBLIC_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/** How the current key was obtained: "public" or "page". */


/** How the current key was obtained: "public" or "page". */
let innertubeKey = INNERTUBE_PUBLIC_KEY;

/** Extracts the key from the HTML of a YouTube page. */


/** Extracts the key from the HTML of a YouTube page. */
function innertubeKeyFrom(page) {
  return page.text.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1] ?? null;
}

/**
 * The key that will be used, and also the one kept in memory. It only scrapes the
 * page if the public one has stopped working.
 */


/**
 * The key that will be used, and also the one kept in memory. It only scrapes the
 * page if the public one has stopped working.
 */
function adoptInnertubeKey(found) {
  if (!found || found === innertubeKey) return innertubeKey;

  innertubeKey = found;

  return found;
}

/**
/**
 * Page scraping, only if the stored key stopped working. Returns the key to use
 * from now on, or `null` if not even the page answers.
 *
 * This is reached via a 400 from InnerTube, which is what happens when YouTube
 * rotates the key. A 429 or a 403 is not counted: those are the IP's limit, and
 * scraping the page does not fix them —it only spends another call and makes the
 * limit worse.
 */


/**
/**
 * Page scraping, only if the stored key stopped working. Returns the key to use
 * from now on, or `null` if not even the page answers.
 *
 * This is reached via a 400 from InnerTube, which is what happens when YouTube
 * rotates the key. A 429 or a 403 is not counted: those are the IP's limit, and
 * scraping the page does not fix them —it only spends another call and makes the
 * limit worse.
 */
async function refreshInnertubeKey(pageUrl) {
  const page = await fetchPage(pageUrl, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    ...cookieHeader("YT_COOKIE"),
  });

  if (!page.ok) {
    throw Object.assign(new Error(`YouTube responded ${page.status}`), { status: page.status });
  }

  return adoptInnertubeKey(innertubeKeyFrom(page));
}

/** Is the failure an expired key, or is it the IP's limit? */


/** Is the failure an expired key, or is it the IP's limit? */
function keyLooksDead(error) {
  return error?.status === 400 || error?.status === 401;
}


function hasYouTubeAudio(format) {
  return Boolean(format.audioQuality) || /(?:mp4a|opus|vorbis)/i.test(format.mimeType ?? "");
}


function selectYouTubeFormat(streamingData) {
  const formats = [
    ...(streamingData?.formats ?? []),
    ...(streamingData?.adaptiveFormats ?? []),
  ].filter((format) => format.url && /^video\//i.test(format.mimeType ?? ""));
  const withAudio = formats.filter(hasYouTubeAudio);

  return (withAudio.length ? withAudio : formats).sort((a, b) => {
    const pixelsA = Number(a.width ?? 0) * Number(a.height ?? 0);
    const pixelsB = Number(b.width ?? 0) * Number(b.height ?? 0);
    return pixelsB - pixelsA || Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0);
  })[0];
}


function selectYouTubeAudio(streamingData) {
  const audios = [
    ...(streamingData?.adaptiveFormats ?? []),
    ...(streamingData?.formats ?? []),
  ].filter((format) => format.url && /^audio\//i.test(format.mimeType ?? ""));

  return audios.sort((a, b) => {
    const mp4A = Number(/audio\/mp4/i.test(a.mimeType ?? ""));
    const mp4B = Number(/audio\/mp4/i.test(b.mimeType ?? ""));

    return mp4B - mp4A || Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0);
  })[0];
}

/** Highest resolution thumbnail the player offers. */


/** Highest resolution thumbnail the player offers. */
function bestYouTubeThumbnail(player) {
  const thumbs = (player?.videoDetails?.thumbnail?.thumbnails ?? []).filter((thumb) => thumb?.url);
  const best = thumbs
    .map((thumb) => ({
      url: thumb.url,
      area: Number(thumb.width ?? 0) * Number(thumb.height ?? 0),
    }))
    .sort((a, b) => b.area - a.area)[0];

  if (best) return best.url;

  const videoId = player?.videoDetails?.videoId;

  return videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null;
}

/** Real format of an image (YouTube serves webp even when the URL says jpg). */


/** Real format of an image (YouTube serves webp even when the URL says jpg). */
async function imageExtension(url) {
  try {
    const response = await fetchTimed(url, {
      method: "HEAD",
      headers: { "User-Agent": MOBILE_USER_AGENT },
    });

    await response.body?.cancel();

    return extensionOf(response.headers.get("content-type")) ?? "jpg";
  } catch {
    return "jpg";
  }
}

/**
 * Did the player come back empty because of a request limit or because the video
 * is not downloadable? YouTube does not say clearly, but a 429 comes with its own
 * reason and sometimes with a `reason` that spells it out.
 */


/**
 * Did the player come back empty because of a request limit or because the video
 * is not downloadable? YouTube does not say clearly, but a 429 comes with its own
 * reason and sometimes with a `reason` that spells it out.
 */
function isRateLimited(player) {
  const status = String(player?.playabilityStatus?.status ?? "");
  const reason = String(player?.playabilityStatus?.reason ?? "").toLowerCase();

  return /RATE_LIMIT|LIMIT_EXCEEDED|UNPLAYABLE/i.test(status)
    || /too many requests|rate limit|exceeded/i.test(reason);
}


async function fetchYouTubePlayer(apiKey, videoId, client) {
  const response = await fetchTimed(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        "X-YouTube-Client-Name": String(client.id),
        "X-YouTube-Client-Version": client.version,
        Origin: "https://www.youtube.com",
        Referer: "https://www.youtube.com/",
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            ...client.context,
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    },
  );

  /* The status goes in the error so the caller can tell a 429 —which is the
     IP's problem— from a 404 —which is the video's. */
  if (!response.ok) {
    throw Object.assign(new Error(`YouTube responded ${response.status}`), { status: response.status });
  }

  return response.json();
}

/**
 * Consecutive YouTube failures that carried no rate-limit signal of their own.
 *
 * It used to be a plain counter, so two failures of *any* kind were enough to
 * start blaming Cloudflare's IP: two private videos, two deleted ones, and the
 * next message said "YouTube is rate-limiting you, it is not the video". That is
 * a diagnosis that sends the user off to debug something that is fine, and it is
 * the kind of thing that only shows up on a platform where a lot of links are
 * dead.
 *
 * The counter is now only consulted for failures YouTube did not explain, and it
 * is reset by `ytForgiven()` on any success, so a run of unexplained failures
 * has to be *consecutive* to mean anything.
 */


/**
 * Consecutive YouTube failures that carried no rate-limit signal of their own.
 *
 * It used to be a plain counter, so two failures of *any* kind were enough to
 * start blaming Cloudflare's IP: two private videos, two deleted ones, and the
 * next message said "YouTube is rate-limiting you, it is not the video". That is
 * a diagnosis that sends the user off to debug something that is fine, and it is
 * the kind of thing that only shows up on a platform where a lot of links are
 * dead.
 *
 * The counter is now only consulted for failures YouTube did not explain, and it
 * is reset by `ytForgiven()` on any success, so a run of unexplained failures
 * has to be *consecutive* to mean anything.
 */
let ytBackoff = 0;


function ytThrottled() {
  return ytBackoff >= 3;
}


function ytBackoffTick() {
  ytBackoff += 1;
}


function ytForgiven() {
  ytBackoff = 0;
}


export async function getYouTubeMedia(videoId) {
  const pageUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  let apiKey = innertubeKey;
  let refreshed = false;

  const clients = [
    {
      id: 3,
      name: "ANDROID",
      version: "20.10.38",
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
      context: { androidSdkVersion: 30, hl: "en", gl: "US" },
    },
    {
      id: 5,
      name: "IOS",
      version: "20.10.4",
      userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3 like Mac OS X)",
      context: { deviceModel: "iPhone16,2", hl: "en", gl: "US" },
    },
  ];

  let rateLimited = false;

  for (const client of clients) {
    try {
      const player = await fetchYouTubePlayer(apiKey, videoId, client);
      const format = selectYouTubeFormat(player.streamingData);

      /* No formats does not mean the video does not exist: when Cloudflare
         overdoes it YouTube returns an empty player, with the same shape as a
         video that is real but not downloadable. Both cases used to come back
         with the same error, which said nothing about which one it was. */
      if (!format && player.playabilityStatus?.status !== "OK") {
        rateLimited = rateLimited || isRateLimited(player);
      }

      if (player.playabilityStatus?.status === "OK" && format) {
        ytForgiven();

        const files = [{
          media: [format.url],
          isVideo: true,
          kind: "video",
          extension: /webm/i.test(format.mimeType ?? "") ? "webm" : "mp4",
          hasAudio: hasYouTubeAudio(format),
        }];
        const cover = bestYouTubeThumbnail(player);
        const audio = selectYouTubeAudio(player.streamingData);

        if (audio) {
          files[0].converted = true;
          files.push({
            media: [audio.url],
            fallback: [format.url],
            isVideo: false,
            kind: "audio",
            extension: /webm|opus/i.test(audio.mimeType ?? "") ? "opus" : "m4a",
          });
        } else if (hasYouTubeAudio(format)) {
          files[0].converted = true;
          files.push({
            media: [format.url],
            isVideo: false,
            kind: "audio",
            extension: "m4a",
          });
        }

        if (cover) {
          files.push({
            media: [cover],
            isVideo: false,
            kind: "image",
            extension: await imageExtension(cover),
          });
        }

        return { files, prefix: `youtube-${videoId}`, referer: pageUrl };
      }
    } catch (error) {
      if (error?.status === 429) rateLimited = true;

      /* Only a failure YouTube did not explain counts towards the backoff. By the
         time the code is here, `rateLimited` already means YouTube said so —
         either the player came back with RATE_LIMIT or the response was a 429 —
         so testing it here is the whole test. Charging anything else to the
         counter is what used to make two dead links in a row come out as
         "Cloudflare is rate-limiting you". */
      if (!rateLimited) ytBackoffTick();

      /* The page scraping cost is only paid if the key looks expired, and only
         once per isolate. That path goes back to the old one: reading the HTML to
         get the key. That is what always happened before, and now it only happens
         if YouTube rotates the public key. */
      if (!refreshed && keyLooksDead(error)) {
        refreshed = true;

        try {
          apiKey = (await refreshInnertubeKey(pageUrl)) ?? apiKey;
        } catch {}
      }
    }
  }

  /* YouTube's 429 is not caused by this link: it is caused by the IP. The
     Cloudflare ones are on the list of those limited earlier, because many
     Workers share them. Saying so is more useful than "did not return a
     stream", which does not make clear whether the video is bad or the network
     is. */
  /* `explain()` marked this as the fault of whoever pasted the link, and because
     of that it came out as a 400: a 400 says "your link is wrong, do not repeat
     it". What is actually here is a limit on the address, and the right answer is
     a 429 so that it can be told apart from a real failure, both for the caller
     and for Cloudflare's dashboard, where a 429 and a 500 are two different
     things. That is why it carries a status and no `user`. */
  if (rateLimited || ytThrottled()) {
    throw withStatus(
      new Error(
        "YouTube is rate-limiting requests from this server. It is not the video: "
        + "it is Cloudflare's IP, which is shared between many Workers and runs out of turns sooner. "
        + "Wait a few minutes and try again.",
      ),
      429,
    );
  }

  throw explain("YouTube returned no downloadable stream");
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectYouTube(source) {
  const id = extractYouTubeVideoId(source);
  if (!id) return null;

  const youtube = await getYouTubeMedia(id);

  return {
    files: youtube.files,
    prefix: youtube.prefix,
    referer: youtube.referer,
  };
}
