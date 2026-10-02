/* Bilibili. Everything that knows about this one site lives here and nowhere
 * else: the link patterns, the requests, and how its answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a relative import:
 * `tools/build.mjs` strips it when it flattens every file into the single Worker,
 * and there it is already in scope. */
import {
  DESKTOP_USER_AGENT,
  explain,
  fetchPage,
} from "../core.mjs";

/**
 * Bilibili ids out of a link.
 *
 * Two alphabets, not one: `BV1qM4y1w716` (a `BV` plus ten) and the older `av170001`.
 * Both have a fixed length, which is what the pattern leans on — a looser one would
 * match any `video/<something>` and then the API would answer for a video that is
 * not there. The short link `b23.tv/<code>` is not in here: it is a redirect, and
 * resolving it is one more request, so it is expanded rather than matched.
 *
 * The part after `?p=` is the episode inside a multi-part video. It is kept because
 * each part is a different video with its own streams and needs its own `cid`.
 */
function extractBilibiliRef(value) {
  const text = String(value ?? "");

  const bvid = text.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]{10})(?:[/?#]|$)/)?.[1];
  const avid = text.match(/bilibili\.com\/video\/(av\d{4,})(?:[/?#]|$)/)?.[1];

  if (!bvid && !avid) return null;

  const part = text.match(/[?&]p=(\d{1,4})/)?.[1] ?? null;

  return { bvid: bvid ?? null, avid: avid ?? null, part };
}

/**
 * The `cid` of the video, which the playurl endpoint needs and the URL does not have.
 *
 * It is not the `bvid`: it is the id of one file, and a multi-part video has one per
 * part. The page carries it in its inline state, and when `?p=` is present the part
 * is matched by its page number rather than taken as the first one, because asking
 * for part 3 and getting part 1 would download the wrong episode with the right
 * filename.
 */
async function bilibiliCid(bvid, part) {
  const page = await fetchPage(`https://www.bilibili.com/video/${encodeURIComponent(bvid)}/`, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  });

  if (!page.ok) throw explain(`Bilibili responded ${page.status}`);

  const html = page.text;

  /* Parts first: each one carries its own `cid` and its `page` number, and the
     order in the HTML is not the order on screen. */
  const parts = [...html.matchAll(/"cid":(\d+),"page":(\d+)/g)].map((m) => ({ cid: m[1], page: Number(m[2]) }));

  if (part) {
    const chosen = parts.find((p) => p.page === Number(part));

    if (chosen) return chosen.cid;
  }

  const looseCid = parts[0]?.cid;

  if (looseCid) return looseCid;

  const firstCid = /"cid":(\d+)/.exec(html)?.[1];

  if (firstCid) return firstCid;

  throw explain("That Bilibili video could not be read: it may be private or region-locked");
}

/**
 * Videos from a Bilibili id.
 *
 * The playurl API answers with DASH: the video track and the audio track are two
 * separate files, and joining them needs ffmpeg, which a Worker does not have. So
 * both are given as what they are —the video, and the audio on its own —rather than
 * pretending there is one file. That is the same choice every other platform makes
 * with its audio-only copy.
 *
 * Only AVC video is taken. The API also offers HEVC and AV1, which a browser plays
 * and this does not: the file is handed to the browser to play, and one it cannot
 * decode is a black rectangle with nothing in the page to explain it.
 */
async function fetchBilibiliMedia(bvid, part) {
  const cid = await bilibiliCid(bvid, part);

  const playurl = await fetchPage(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}`
    + `&cid=${encodeURIComponent(cid)}&qn=64&fnval=16`,
    {
      "User-Agent": DESKTOP_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "application/json",
      Referer: `https://www.bilibili.com/video/${bvid}/`,
    },
  );

  if (!playurl.ok) throw explain(`Bilibili responded ${playurl.status}`);

  let meta = null;

  try {
    meta = JSON.parse(playurl.text);
  } catch {}

  if (meta?.code !== 0) {
    /* `-404` is what it answers for a video that is not visible from here: deleted,
       private, or blocked in this region. Saying so is more useful than the bare
       number, which tells the reader nothing. */
    throw explain(
      meta?.code === -404
        ? "That Bilibili video is not available: it may be private, or blocked in this region"
        : `Bilibili answered ${meta?.code ?? "an unreadable error"}`,
    );
  }

  const dash = meta?.data?.dash;

  if (!dash) throw explain("That Bilibili video has no downloadable stream");

  const address = (track) => track?.baseUrl ?? track?.base_url ?? null;

  const videos = (dash.video ?? [])
    .filter((track) => address(track))
    .filter((track) => !track.codecs || /avc1/i.test(track.codecs))
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  if (!videos.length) throw explain("That Bilibili video has no downloadable video track");

  const mejor = videos[0];
  const files = [{
    media: [address(mejor)],
    isVideo: true,
    kind: "video",
    extension: "mp4",
    label: mejor.width && mejor.height ? `${mejor.width}x${mejor.height}` : null,
  }];

  const audios = (dash.audio ?? [])
    .filter((track) => address(track))
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));

  if (audios.length) {
    /* The audio is a separate file and always will be. It is offered as its own
       item, which is the honest description, and it is the one Bilibili viewers
       most often want anyway: the audio track of a talk or a song.

       The video is marked `converted` so the dispatcher does not add its own
       audio copy of it on top. That copy is the same mp4 renamed, which is the
       right thing to synthesise for a platform that only ever hands over video;
       here the real track already exists, and a second audio item that is just
       the video again is noise that looks like a mistake. */
    files[0].converted = true;

    files.push({
      media: [address(audios[0])],
      isVideo: false,
      kind: "audio",
      extension: "m4a",
      label: "bilibili audio track",
    });
  }

  return files;
}

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the dispatcher
 * move on to the next platform. Everything else throws, with a message meant for
 * whoever pasted the link.
 */
export async function detectBilibili(source) {
  const ref = extractBilibiliRef(source);

  if (!ref) return null;

  const bvid = ref.bvid ?? await bilibiliBvidDe(ref.avid);
  const files = await fetchBilibiliMedia(bvid, ref.part);

  return {
    files,
    prefix: `bilibili-${bvid}${ref.part ? `-p${ref.part}` : ""}`,
    referer: `https://www.bilibili.com/video/${bvid}/`,
  };
}

/**
 * Turns an `av` number into the `BV` name the API wants.
 *
 * Both name the same video and the playurl endpoint only accepts `bvid`, so a link
 * of the older form has to be translated. The page knows the answer, and it also
 * confirms the video is visible from here: asking for an `av` video that is private
 * comes back with no `bvid` at all, which is the honest answer rather than a guess.
 */
async function bilibiliBvidDe(avid) {
  const page = await fetchPage(`https://www.bilibili.com/video/${encodeURIComponent(avid)}/`, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  });

  if (!page.ok) throw explain(`Bilibili responded ${page.status}`);

  const bvid = /"bvid":"(BV[a-zA-Z0-9]{10})"/.exec(page.text)?.[1];

  if (!bvid) {
    throw explain("That Bilibili video is not available: it may be private, or blocked in this region");
  }

  return bvid;
}