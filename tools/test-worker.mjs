// Exercises the Worker handler without wrangler: it is called exactly the way
// Cloudflare would call it. `caches` does not exist outside that runtime, so this
// also checks the page is fetched directly when the cache is unavailable.
//
// Unlike the first version, this does more than print: it reports failures and
// exits non-zero when something does not add up. `npm run check` chains this with
// `&&`, so the test has to be able to fail or the step after it never runs.
//
// It does NOT need no network, whatever the README used to say. Three routes go
// out to the internet: TikTok for the proxy check, and the repository for the
// page and for the share image. That is deliberate — those are the only places
// where a real integration is the only honest test — but it means the suite can
// be red for a reason that has nothing to do with the code, and the two live
// checks that depend on GitHub are non-fatal for that reason.
import worker from "../worker.js";

const host = "https://downloader.example.workers.dev";
const call = (path, init) => worker.fetch(new Request(host + path, init), {});

const out = {};
const failures = [];

/** Checks an equality and records the failure if it does not hold. */
function check(label, condition, actual, expected) {
  if (condition) return true;

  failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

  return false;
}

// ------------------------------------------------------------ routes and method

out.methodNotAllowed = (await call("/api/resolve", { method: "POST" })).status;
check("POST on /api/resolve is rejected", out.methodNotAllowed === 405, out.methodNotAllowed, 405);

out.notFound = (await call("/nothing")).status;
check("a route that does not exist gives 404", out.notFound === 404, out.notFound, 404);

out.favicon = (await call("/favicon.ico")).status;
check("the favicon answers 204 with no body", out.favicon === 204, out.favicon, 204);

// ----------------------------------------------------------------------- the API

/* A string that is not a link: it has to give 400 with the exact message, not a
   generic 500. This is the path that was fixed so the server text reaches the
   reader verbatim. */
{
  const response = await call("/api/resolve?url=this-is-not-a-link");
  const body = await response.json().catch(() => ({}));

  out.resolveError = { status: response.status, body: body.error ?? "(no error)" };

  check("an invalid link gives 400", response.status === 400, response.status, 400);
  check(
    "the message says only http or https are accepted",
    /http/i.test(body.error ?? ""),
    body.error,
    "something containing http",
  );
}

/* Proxy addresses must be absolute. This is what fixed a past deploy: a relative
   path only works if whoever reads the response is already on this origin. */
{
  const response = await call("/api/resolve?url=https%3A%2F%2Fwww.tiktok.com%2F%40leitokqkelwkwlqk%2Fvideo%2F7613190702360431879");
  const body = await response.json().catch(() => ({}));

  const withProxy = (body.items ?? []).filter((item) => item.proxy);

  out.proxy = {
    status: response.status,
    items: (body.items ?? []).length,
    withProxy: withProxy.length,
    allAbsolute: withProxy.every((item) => item.proxy.startsWith("https://")),
  };

  if (response.ok) {
    check("proxy addresses are absolute", out.proxy.allAbsolute, out.proxy, "all starting with https://");
  } else {
    /* Before, a network failure made this check vanish: nothing was compared, and
       the suite still ended green. A check that only runs when the network is up
       cannot report a broken Worker, which is the only thing it is for. So a
       failure is reported, as a failure of the test rather than of the Worker —
       which is what it is: this is the one route that needs a live platform. */
    console.log(`warning: the proxy check did not run, /api/resolve answered ${response.status}`);
    failures.push(
      `proxy check skipped: the live platform answered ${response.status}, so nothing was verified`,
    );
  }
}

/* Which platform a link belongs to.
 *
 * The case that made this worth a test: Facebook's id extractor used to accept a
 * bare `?v=` from any host, and Facebook is tried before YouTube, so a YouTube
 * video whose id was all digits — `watch?v=12345678901` — was read as a Facebook
 * reel and failed there with "not available without signing in" instead of
 * resolving. Nothing about the request was wrong; only the reading of the link
 * was. Offline, so it always runs. */
{
  const { detectSource } = await import("../src/dispatch.mjs");

  out.platformOf = {
    youtubeNumeric: detectSource("https://www.youtube.com/watch?v=12345678901"),
    youtubeNormal: detectSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    facebookReel: detectSource("https://www.facebook.com/reel/981357271035818"),
    fbWatch: detectSource("https://fb.watch/abc123def/"),
    dailymotion: detectSource("https://www.dailymotion.com/video/x9l9zoo"),
    threads: detectSource("https://www.threads.net/@zendtay/post/C1abcdefg"),
    nitter: detectSource("https://nitter.net/jack/status/20"),
    unknown: detectSource("https://example.com/video.mp4"),
  };

  check(
    "a YouTube link with an all-digit id is YouTube, not Facebook",
    out.platformOf.youtubeNumeric === "youtube",
    out.platformOf.youtubeNumeric,
    "youtube",
  );
  check(
    "an ordinary YouTube link is YouTube",
    out.platformOf.youtubeNormal === "youtube",
    out.platformOf.youtubeNormal,
    "youtube",
  );
  check(
    "a Facebook reel is Facebook",
    out.platformOf.facebookReel === "facebook",
    out.platformOf.facebookReel,
    "facebook",
  );
  check(
    "an fb.watch short link is Facebook",
    out.platformOf.fbWatch === "facebook",
    out.platformOf.fbWatch,
    "facebook",
  );
  check(
    "a Dailymotion link is Dailymotion",
    out.platformOf.dailymotion === "dailymotion",
    out.platformOf.dailymotion,
    "dailymotion",
  );
  check(
    "a Threads link is Threads",
    out.platformOf.threads === "threads",
    out.platformOf.threads,
    "threads",
  );
  check(
    "a nitter.net link is X, the same as x.com",
    out.platformOf.nitter === "x",
    out.platformOf.nitter,
    "x",
  );
  check(
    "a link from nowhere is not a platform",
    out.platformOf.unknown === null,
    out.platformOf.unknown,
    null,
  );
}

// ----------------------------------------------------------------------- the page

{
  const response = await call("/");
  const html = await response.text();
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  const ogImage = html.match(/<meta property="og:image" content="([^"]*)"/)?.[1] ?? "";
  const ogUrl = html.match(/<meta property="og:url" content="([^"]*)"/)?.[1] ?? "";
  const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? "";
  const lang = html.match(/<html lang="([^"]*)"/)?.[1] ?? "";
  const csp = response.headers.get("content-security-policy") ?? "";

  out.page = {
    status: response.status,
    type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"),
    bytes: html.length,
    isHtml: html.startsWith("<"),
    title,
    titleLength: title.length,
    description,
    descriptionLength: description.length,
    ogImage,
    ogUrl,
    canonical,
    lang,
    cspPresent: csp.length > 0,
    // The part of the CSP worth watching is the fonts. No webfont is used, so
    // `font-src` has to stay exactly at 'self' data: — anything else means
    // someone added an outside font by accident. Scripts and styles do allow
    // jsdelivr, which is where video.js comes from, on purpose.
    fontSrc: csp.match(/font-src ([^;]+)/)?.[1]?.trim() ?? "(no font-src)",
    jsDelivr: /cdn\.jsdelivr\.net/.test(csp),
  };

  check("the page answers 200", response.status === 200, response.status, 200);
  check("the page is real HTML", out.page.isHtml, out.page.isHtml, true);
  check("the page has a title", title.length > 0, title, "some text");
  check("the page has a description", description.length > 0, description, "some text");
  check("the page has og:image", ogImage.startsWith("https://"), ogImage, "an https URL");
  check("the CSP is present", out.page.cspPresent, out.page.cspPresent, true);
  check(
    "font-src stays at 'self' data:, no outside webfonts",
    out.page.fontSrc === "'self' data:",
    out.page.fontSrc,
    "'self' data:",
  );
  check("jsdelivr is still allowed for scripts", out.page.jsDelivr, out.page.jsDelivr, true);
}

/* The share image has to come out of the Worker with its content type set, or
   social platforms render it blank. */
{
  const response = await call("/images/og.png");

  out.ogImage = {
    status: response.status,
    type: response.headers.get("content-type"),
  };

  await response.body?.cancel();

  if (response.status !== 200) {
    // Not a hard failure: the image lives on GitHub and its network can fail.
    // Warn, but do not fail the test for it.
    console.log("warning: /images/og.png did not give 200, status:", response.status);
  } else {
    /* The comment above this block states the invariant and the code read the
       value that would test it, and then never compared it with anything: the
       Worker could drop `Content-Type: image/png` tomorrow and the suite would
       still print "all checks passed", with the value sitting in the dump unused.
       It is only asserted when the request got a body, because the two live
       checks on this route are deliberately non-fatal. */
    check("the share image keeps its content type", out.ogImage.type === "image/png", out.ogImage.type, "image/png");
  }
}

// ---------------------------------------------------------------------- the result

console.log(JSON.stringify(out, null, 1));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:`);

  for (const failure of failures) console.error("  -", failure);

  process.exit(1);
}

console.log("\nall checks passed");
