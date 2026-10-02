/* Loom. Everything that knows about this one site lives here and nowhere else:
 * the link patterns, the requests, and how its answer is turned into files.
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
 * Loom ids out of a link.
 *
 * Thirty-two hex characters, and the shapes are `/share/<id>`, `/embed/<id>` and
 * `/share/?sid=<id>`. The last two are why the id is looked for in the query string
 * too: Loom's own embed code uses `?sid=` and those links get copied from a
 * webpage's source as often as from the address bar.
 */
function extractLoomId(value) {
  const text = String(value ?? "");

  return text.match(/loom\.com\/share\/([a-f0-9]{32})/i)?.[1]
    ?? text.match(/loom\.com\/embed\/([a-f0-9]{32})/i)?.[1]
    ?? text.match(/loom\.com\/share\/?\?(?:[^#]*&)?sid=([a-f0-9]{32})/i)?.[1]
    ?? null;
}

/**
 * Videos from a Loom id.
 *
 * The address of the file is not in the page and not in the share page either: it
 * comes from a POST to the session endpoint, which is what Loom's own player calls.
 * Two of those endpoints exist —`raw-url` and `transcoded-url`— and the transcoded
 * one is tried first because it gives the smaller, better-encoded file.
 *
 * The URL it answers with is signed by CloudFront and carries an expiry inside the
 * `Policy=` parameter. It is therefore resolved here and not handed over to be
 * fetched later: the same request made an hour from now would come back 403, and
 * the failure would read as the recording having been deleted.
 */
/**
 * One POST to a Loom session endpoint.
 *
 * `fetchPage` takes its options fifth and the request body is part of them, so the
 * call reads `fetchPage(url, headers, 0, 0, { body })`. Passing the body in the
 * fourth slot —where the byte limit goes— sends it as the limit and leaves the
 * request a GET, which Loom answers with a body-less-request error.
 */
async function postSession(url, headers, body) {
  return fetchPage(url, headers, 0, 0, { method: "POST", body: JSON.stringify(body) });
}

async function fetchLoomMedia(videoId) {
  const referer = `https://www.loom.com/share/${videoId}`;

  const headers = {
    "User-Agent": DESKTOP_USER_AGENT,
    "Content-Type": "application/json",
    Origin: "https://www.loom.com",
    Referer: referer,
    /* Loom's web client sends this on both endpoints. Without it the session
       endpoint answers 404 for a recording that exists and is public. */
    "X-Loom-Request-Source": "loom_web_be851af",
  };

  let fileUrl = null;

  for (const endpoint of ["transcoded-url", "raw-url"]) {
    const response = await postSession(
      `https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`,
      headers,
      {
        force_original: false,
        password: null,
        client_name: "web",
        deviceID: null,
        supported_mime_types: ["video/mp4"],
      },
    );

    if (!response.ok) continue;

    let body = null;

    try {
      body = JSON.parse(response.text);
    } catch {}

    /* The check is for `.mp4` and not for "is there a url": Loom answers 200 with
       a JSON body and no file for a recording whose transcoding has not finished,
       and treating that as success would produce a download of nothing. */
    if (/\.mp4\?/i.test(body?.url ?? "")) {
      fileUrl = body.url;
      break;
    }
  }

  if (!fileUrl) {
    throw explain("That Loom recording is not public, or it is still being processed");
  }

  const files = [{ media: [fileUrl], isVideo: true, kind: "video", extension: "mp4" }];

  /* The title is read from the share page, which is a separate request. It is
     worth one: "Replacing a meeting with Loom" tells the reader what the file is,
     and `loom-2a742981.mp4` does not. A page that does not answer costs nothing
     but the name, so a failure here is not fatal. */
  const page = await fetchPage(referer, {
    "User-Agent": DESKTOP_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
  });

  if (page.ok) {
    const title = /property="og:title"\s+content="([^"]+)"/.exec(page.text)?.[1];

    if (title) {
      files[0].label = title.trim();
      files[0].title = title.trim();
    }

    const cover = /property="og:image"\s+content="([^"]+)"/.exec(page.text)?.[1];

    if (cover) files.push({ media: [cover], isVideo: false, kind: "image" });
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
export async function detectLoom(source) {
  const id = extractLoomId(source);

  if (!id) return null;

  return {
    files: await fetchLoomMedia(id),
    prefix: `loom-${id.slice(0, 8)}`,
    referer: `https://www.loom.com/share/${id}`,
  };
}