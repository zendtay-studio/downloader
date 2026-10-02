/* Spotify. Everything that knows about this one site lives here and
 * nowhere else: the link patterns, the requests, and how its
 * answer is turned into files.
 *
 * The plumbing it borrows comes from `../core.mjs`, which is a
 * relative import: `tools/build.mjs` strips it when it flattens
 * every file into the single Worker, and there it is already in
 * scope. */
import {
  DESKTOP_USER_AGENT,
  withStatus,
  explain,
  fetchPage,
  platformOf,
} from "../core.mjs";


/**
 * Spotify: /track/<id>, /album/<id>, /playlist/<id>, /artist/<id> and podcasts,
 * with or without a language prefix (/intl-es/…). The `spotify:track:<id>` URI
 * and spotify.link short links also work, the latter by following the redirect.
 */
function extractSpotifyRef(value) {
  const text = String(value ?? "");

  if (platformOf(text) !== "spotify") return null;

  const uri = text.match(/spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]{10,})/i);
  const path = text.match(/\/(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{10,})/i);
  const found = uri ?? path;

  // No readable id: it is a short link. Let it redirect and decide afterwards
  // from the URL that was reached.
  return found
    ? { kind: found[1].toLowerCase(), id: found[2] }
    : { kind: "redirect", id: null };
}


const SPOTIFY_NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

/** The embed's `__NEXT_DATA__` holds the track, the album or — for an artist —
 *  the full list with each one's preview. */


/** The embed's `__NEXT_DATA__` holds the track, the album or — for an artist —
 *  the full list with each one's preview. */
function spotifyEntity(html) {
  const raw = html.match(SPOTIFY_NEXT_DATA)?.[1];

  if (!raw) return null;

  try {
    return JSON.parse(raw)?.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

/**
 * Spotify DRM-encrypts full songs, so they cannot be downloaded. What it does
 * publish openly is the official 30-second preview of each track
 * (`p.scdn.co`), and that is what is handed over here: a single track gives one
 * item, an album, playlist or artist gives one per song.
 */


/**
 * Spotify DRM-encrypts full songs, so they cannot be downloaded. What it does
 * publish openly is the official 30-second preview of each track
 * (`p.scdn.co`), and that is what is handed over here: a single track gives one
 * item, an album, playlist or artist gives one per song.
 */
async function fetchSpotifyMedia(url, ref) {
  let kind = ref.kind;
  let id = ref.id;

  if (!id) {
    const short = await fetchPage(url, { "User-Agent": DESKTOP_USER_AGENT });
    const landed = extractSpotifyRef(short.url ?? url);

    if (!landed?.id) throw explain("That Spotify link does not point to a track, an album or an artist");

    kind = landed.kind;
    id = landed.id;
  }

  const page = await fetchPage(`https://open.spotify.com/embed/${kind}/${id}`, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  });

  if (!page.ok) throw withStatus(new Error(`Spotify responded ${page.status}`), page.status);

  const entity = spotifyEntity(page.text);

  if (!entity) throw explain("That Spotify link could not be read");

  const tracks = entity.trackList?.length ? entity.trackList : [entity];

  /* The cover of the song or the record. It is only used as a blurred backdrop,
     so the largest of those in `visualIdentity` is enough: the first is 64 px
     and stretched it turns into a smudge. Previews carry no photo of their
     own, so for a single track it falls back to the album's, which is the best
     available. */
  const coverOf = (track) => {
    const images = track?.visualIdentity?.image ?? track?.coverArt?.images;
    const sizes = (Array.isArray(images) ? images : []).map((image) => image?.url).filter(Boolean);

    return sizes.at(-1) ?? null;
  };

  const files = tracks
    .filter((track) => track.audioPreview?.url)
    .map((track) => ({
      media: [track.audioPreview.url],
      isVideo: false,
      kind: "audio",
      extension: "mp3",
      // The real file name and the card text: without them, with twenty
      // previews on screen there is no telling them apart.
      label: track.title ?? track.name ?? "",
      title: [track.title ?? track.name, track.subtitle].filter(Boolean).join(" — "),
      cover: coverOf(track) ?? coverOf(entity),
    }));

  if (!files.length) throw explain("Spotify has no public preview of that content");

  return files;
}

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

/**
 * Recognises this platform's links and resolves them.
 *
 * Returns `null` when the link is not its own, which is what lets the
 * dispatcher move on to the next platform. Everything else throws, with a
 * message meant for whoever pasted the link.
 */
export async function detectSpotify(source) {
  const ref = extractSpotifyRef(source);
  if (!ref) return null;

  return {
    files: await fetchSpotifyMedia(source, ref),
    prefix: "spotify",
    referer: "https://open.spotify.com/",
  };
}
