/* Which platform a link belongs to, and who resolves it.
 *
 * This file is the front door and nothing else: the table of platforms, the
 * order they are tried in, and the glue that turns what one returns into the
 * answer the API gives. Everything that knows about a particular site lives in
 * `src/platforms/<site>.js`, and everything shared lives in `src/core.mjs`.
 *
 * That split is the reason a new site is one small file instead of two hunks
 * pasted into a 3,000-line switch: the pattern that reads the link, the request
 * it makes and how its answer is read are all in the same place, and adding one
 * cannot disturb another because they share nothing but the core.
 */
import {
  DESKTOP_USER_AGENT,
  explain,
  platformOf,
} from "./core.mjs";
import {
  detectFacebook,
} from "./platforms/facebook.js";
import {
  detectInstagram,
} from "./platforms/instagram.js";
import {
  detectThreads,
} from "./platforms/threads.js";
import {
  detectTikTok,
} from "./platforms/tiktok.js";
import {
  detectYouTube,
  getYouTubeMedia,
  getYouTubePlaylist,
} from "./platforms/youtube.js";
import {
  detectVimeo,
} from "./platforms/vimeo.js";
import {
  detectStreamable,
} from "./platforms/streamable.js";
import {
  detectRutube,
} from "./platforms/rutube.js";
import {
  detectBilibili,
} from "./platforms/bilibili.js";
import {
  detectLoom,
} from "./platforms/loom.js";
import {
  detectPinterest,
} from "./platforms/pinterest.js";
import {
  detectPornhub,
} from "./platforms/pornhub.js";
import {
  detectX,
} from "./platforms/x.js";
import {
  detectBluesky,
} from "./platforms/bluesky.js";
import {
  detectOk,
} from "./platforms/ok.js";
import {
  detectDailymotion,
} from "./platforms/dailymotion.js";
import {
  detectSnapchat,
} from "./platforms/snapchat.js";
import {
  detectKwai,
} from "./platforms/kwai.js";
import {
  detectSpotify,
} from "./platforms/spotify.js";
import {
  detectReddit,
} from "./platforms/reddit.js";
import {
  detectSoundcloud,
} from "./platforms/soundcloud.js";

/**
 * The platforms, in the order they are tried.
 *
 * Order matters and it is not alphabetical: the first extractor that claims a
 * link wins, so a link two of them could read has to go to the one that reads
 * it better. TikTok is near the end because its link has to be expanded first,
 * and a link that survives everything else is the rare case worth the extra
 * requests.
 *
 * Each entry is the platform id —the same one the page paints with— and the
 * function that recognises and resolves it. A function returns `null` when the
 * link is not its platform, which is what lets the loop move on.
 */
const RESOLVERS = [
  ["snapchat", detectSnapchat],
  ["dailymotion", detectDailymotion],
  ["kwai", detectKwai],
  ["spotify", detectSpotify],
  ["soundcloud", detectSoundcloud],
  ["reddit", detectReddit],
  ["bluesky", detectBluesky],
  ["ok", detectOk],
  ["x", detectX],
  ["pornhub", detectPornhub],
  ["pinterest", detectPinterest],
  ["threads", detectThreads],
  ["instagram", detectInstagram],
  ["facebook", detectFacebook],
  ["tiktok", detectTikTok],
  ["youtube", detectYouTube],
  ["vimeo", detectVimeo],
  ["streamable", detectStreamable],
  ["rutube", detectRutube],
  ["bilibili", detectBilibili],
  ["loom", detectLoom],
];

/* Re-exported so that a caller of the API does not need to know which platform
   file a given extractor lives in. Only YouTube has two entry points outside the
   resolver —a playlist is not a link to a single video— so it is the only one
   that needs this. */
export { getYouTubeMedia, getYouTubePlaylist };

export function detectSource(input) {
  return platformOf(input);
}

/**
 * Files behind a link: every extractor is asked, in order, until one says the
 * link is its own.
 *
 * The order the extractors used to be tried in is kept exactly as it was, so a
 * link resolves the same way it did when the whole thing was one file. What
 * changed is that the list is now a table: adding a platform is a new line
 * here and a new file, with no `else if` in the middle of anyone else's code.
 */
export async function resolveMedia(input) {
  let lastError = null;

  /* The domain is checked first because it is free and it settles the question
     for almost every link. Only when a link comes from somewhere unrecognised
     do all the extractors get to look at it, and then the order above is
     what decides. */
  const platform = platformOf(input);

  if (platform) {
    const entry = RESOLVERS.find(([id]) => id === platform);
    const result = await entry[1](input);

    if (result) return withAudioCopies(result);
  } else {
    for (const [id, resolver] of RESOLVERS) {
      try {
        const result = await resolver(input);

        if (result) return withAudioCopies(result);
      } catch (error) {
        /* One extractor refusing a link must not stop the next one from trying:
           the domains in the table overlap —`x.com` and `nitter.net`, `ok.ru`
           and `odnoklassniki.ru`— and a pattern that matches the wrong platform
           should end in "no platform recognised", not in that platform's
           complaint. The last error is kept, because if every extractor refused
           it is the most specific thing that can be said about it. */
        lastError = error;
      }
    }
  }

  /* This is no longer reached from `/api/resolve`: if the platform is not
     recognised, the universal one handles it first. This case is for the other
     calls —`/api/download`, which only accepts already-resolved links— and the
     message does not blame the platform list, which is no longer the front
     door. */
  throw lastError ?? explain("That link could not be identified");
}

/**
 * Every video also offers an audio-only copy: the same file, with an audio
 * extension.
 *
 * It is done here rather than in each extractor because it is a property of the
 * answer, not of any site, and a copy of the same five lines in every platform is as
 * places for it to drift.
 */
function withAudioCopies({ files, prefix, referer }) {
  if (!files.length) throw new Error("No downloadable files were found");

  const audio = files
    .filter((file) => file.kind === "video" && !file.converted && !file.hls)
    .map((file) => ({ ...file, isVideo: false, kind: "audio", extension: "m4a" }));

  return { files: [...files, ...audio], prefix, referer };
}