/* Soundcloud. Everything that knows about this one site lives here and
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
  cookieHeader,
  explain,
  fetchPage,
  fetchTimed,
  platformOf,
} from "../core.mjs";


/**
 * SoundCloud.
 *
 * The audio is not on the page: the page only says *where* it is. And asking
 * for that "where" needs a `client_id` that the page itself hides in its
 * hydration data. Both come out of the same HTML, so there are no keys, no
 * registration and no password-protected API.
 *
 * Without that `client_id` the API answers 401, which is the classic failure
 * when implementing this. And storing it does not help: it expires, so it is
 * read on every call.
 *
 * Short links (`on.soundcloud.com/abc`) answer 302 to the permalink, and
 * `fetchPage` already hands back the URL that was reached in `page.url`.
 */
function extractSoundcloudRef(value) {
  return platformOf(value) === "soundcloud" ? String(value ?? "") : null;
}

/** The data the page boots with: tracks, playlists and the `client_id`. */


/** The data the page boots with: tracks, playlists and the `client_id`. */
const SOUNDCLOUD_HYDRATION = /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);/;


async function fetchSoundcloudMedia(input) {
  const page = await fetchPage(input, {
    "User-Agent": DESKTOP_USER_AGENT,
    ...cookieHeader("SC_COOKIE"),
  });

  if (!page.ok) throw explain("SoundCloud will not show that page");

  const found = page.text.replace(/\\u0026/g, "&").match(SOUNDCLOUD_HYDRATION);

  if (!found) throw explain("That SoundCloud page could not be read");

  let entries;

  try {
    entries = JSON.parse(found[1]);
  } catch {
    throw explain("SoundCloud returned data that could not be read");
  }

  const data = new Map(entries.map((entry) => [entry?.hydratable, entry?.data]));
  const clientId = data.get("apiClient")?.id;
  const entity = data.get("sound") ?? data.get("playlist");

  if (!clientId || !entity) throw explain("That SoundCloud content is not public");

  /* A single track comes on its own; a playlist carries the tracks inside. */
  const sounds = data.get("sound")
    ? [entity]
    : (entity.tracks ?? []).filter((track) => track?.id);

  if (!sounds.length) throw explain("That SoundCloud playlist is empty");

  const groups = await Promise.all(sounds.map((sound) => soundCloudFile(sound, clientId).catch(() => null)));
  const files = groups.filter(Boolean);

  if (!files.length) throw explain("SoundCloud does not serve the audio of that content");

  return files;
}

/** The cover art. The page's version is 100 px and as a backdrop is a smudge. */


/** The cover art. The page's version is 100 px and as a backdrop is a smudge. */
function soundcloudArtwork(sound) {
  const url = String(sound?.artwork_url ?? "").trim();

  if (!url) return null;

  return url.replace(/-large\.(jpg|png|jpeg)/i, "-t500x500.$1");
}

/**
 * From a track to its file. The progressive MP3 is requested when there is
 * one, because it is a single file and nothing has to be assembled; HLS is the
 * fallback.
 *
 * The API returns `{"url": "…"}`: one more layer of indirection, and without
 * handling it the link that gets downloaded would be the JSON, not the sound.
 */


/**
 * From a track to its file. The progressive MP3 is requested when there is
 * one, because it is a single file and nothing has to be assembled; HLS is the
 * fallback.
 *
 * The API returns `{"url": "…"}`: one more layer of indirection, and without
 * handling it the link that gets downloaded would be the JSON, not the sound.
 */
async function soundCloudFile(sound, clientId) {
  const transcodings = sound?.media?.transcodings ?? [];
  const formats = transcodings.map((entry) => entry?.format ?? {});
  const progressive = transcodings.find((entry, i) =>
    formats[i].protocol === "progressive" && /mpeg/.test(formats[i].mime_type ?? ""));
  const chosen = progressive ?? transcodings.find((entry, i) => formats[i].protocol === "progressive")
    ?? transcodings.find((entry, i) => formats[i].protocol === "hls");

  if (!chosen?.url) return null;

  const endpoint = new URL(chosen.url);

  endpoint.searchParams.set("client_id", clientId);

  const response = await fetchTimed(endpoint.href, {
    headers: { "User-Agent": MOBILE_USER_AGENT, Accept: "application/json" },
  });

  if (!response.ok) return null;

  const location = await response.json().then((body) => body?.url).catch(() => null);

  if (!location) return null;

  const hls = chosen.format?.protocol === "hls";

  return {
    media: [location],
    isVideo: false,
    kind: "audio",
    extension: hls ? "m3u8" : "mp3",
    hls,
    // With twenty tracks on screen, without this there is no telling them apart.
    label: sound.title ?? "",
    title: [sound.title, sound.user?.username].filter(Boolean).join(" — "),
    cover: soundcloudArtwork(sound),
  };
}

/**
 * Reddit. Links shared by the app are /r/<sub>/s/<code>, which redirect to the
 * real post; /r/<sub>/comments/<id>/<slug>/, /user/<u>/comments/… and the short
 * old/new domains work too.
 *
 * The `.json` API is closed to datacenter IPs (403), but the embed does serve the
 * post's data: that is where the signed photo URLs come from and, for videos,
 * the HLS playlist.
 */

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectSoundcloud(source) {
  const ref = extractSoundcloudRef(source);
  if (!ref) return null;

  return {
    files: await fetchSoundcloudMedia(ref),
    prefix: "soundcloud",
    referer: "https://soundcloud.com/",
  };
}
