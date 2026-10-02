/**
 * Node server. A thin adapter: all the logic lives in `api.mjs`, which returns a
 * standard `Response` and is the same code the Cloudflare Worker (`worker.js`)
 * runs. Here it only translates `node:http` to `Response` and back.
 *
 * Not needed to publish to Cloudflare: `wrangler deploy`.
 */
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { dispatch, json, statusFor } from "../src/api.mjs";

const PORT = Number(process.env.PORT) || 3000;
/* 127.0.0.1 and not 0.0.0.0, because `/api/*` here has no authentication and
   neither has the platform's own rate limits: on 0.0.0.0 anyone on the same
   network could use this machine to hammer TikTok and YouTube from its IP, and
   to reach whatever this machine can reach. Set HOST=0.0.0.0 to go back to that
   on purpose, which is what you want when testing on a phone. */
const HOST = process.env.HOST || "127.0.0.1";
const PAGE = fileURLToPath(new URL("../index.html", import.meta.url));
const OG_IMAGE = fileURLToPath(new URL("../images/og.png", import.meta.url));
const VIDEO_LIST = fileURLToPath(new URL("../video.json", import.meta.url));

/* Serving media means cutting before the end: if the visitor closes the tab or
   skips an item, the connection breaks mid-pipeline. Without these guards a
   single aborted download takes the whole server down. */
process.on("unhandledRejection", (error) => {
  console.error("interrupted download:", error?.message ?? error);
});

process.on("uncaughtException", (error) => {
  console.error("uncaught exception:", error?.message ?? error);
});

/** Just the headers, so the API does not care where the request came from.
 *
 *  A real `Headers` and not the raw object, because `api.mjs` reads them with
 *  `request.headers.get(name)` and a plain object has no `.get`. It returned
 *  `""` for everything, so every `Range` header was dropped and the video player
 *  could not seek inside a file under `npm start` — while the same file seeked
 *  fine in the Worker, which passes a real `Request`. `Referer` survived only
 *  because it travels as the `?ref=` query parameter, not as a header. */
const asRequestLike = (request) => ({ headers: new Headers(request.headers) });

/** Writes a `Response` out to the Node response. */
async function send(response, target) {
  const { status, headers, body } = response;
  const plain = {};

  for (const [key, value] of headers) plain[key] = value;

  target.writeHead(status, plain);

  if (!body) {
    target.end();
    return;
  }

  await pipeline(Readable.fromWeb(body), target);
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "connect-src 'self' https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw Object.assign(new Error("Method not allowed"), { status: 405 });
    }

    if (url.pathname.startsWith("/api/")) {
      await send(await dispatch(asRequestLike(request), url), response);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": CSP,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });

      await pipeline(createReadStream(PAGE), response);
      return;
    }

    /* The preview image: from disk locally, the Worker fetches it from the
       repository. Both routes are needed so the page looks the same in both. */
    if (url.pathname === "/images/og.png" || url.pathname === "/og-image.png") {
      /* The type goes in by hand, because a streamed file does not get one: a
         response with no `Content-Type` makes a browser guess, and the social
         platforms that read this file guess wrong and render the card blank.
         `/video.json` six lines down sets both headers, so this was the one
         route in the file that forgot. */
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });

      await pipeline(createReadStream(OG_IMAGE), response);
      return;
    }

    /* The installable app's own files: the manifest and the three icons.
     They are a route each rather than one catch-all because the manifest's
     Content-Type is not decorative. Served as `application/octet-stream` — which
     is what a static host does with an extension it does not know — Chrome still
     installs it, but the console fills with a warning about the type, and a
     warning on every load trains people to ignore the console.

     The route and the file are built from one folder name, because they are the
     same path written twice and they drifted the moment the images moved: the URL
     gained `images/` and the file on disk did not, which 404s every icon and
     leaves a manifest that looks fine until something tries to install it. */
    const PWA = {
      "/site.webmanifest": ["application/manifest+json", "site.webmanifest"],
      /* `Object.fromEntries`, not a spread of `.map()`. Spreading an array into
         an object keys it by index — `0`, `1`, `2` — so every route came back
         undefined and all three icons 404'd while the map looked correct in the
         source. */
      ...Object.fromEntries(
        ["icon-192.png", "icon-512.png", "icon-maskable.png"]
          .map((n) => [`/images/${n}`, ["image/png", `images/${n}`]]),
      ),
    };

    if (PWA[url.pathname]) {
      const [tipo, archivo] = PWA[url.pathname];
      const ruta = fileURLToPath(new URL(`../${archivo}`, import.meta.url));

      response.writeHead(200, { "Content-Type": tipo, "Cache-Control": "no-store" });
      await pipeline(createReadStream(ruta), response);
      return;
    }

    /* The background video list. In production the page fetches it from
       `raw.githubusercontent.com`, because the Worker serves no static files
       besides the preview image. Here it comes from disk so it can be tested
       without uploading anything. */
    if (url.pathname === "/video.json") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });

      await pipeline(createReadStream(VIDEO_LIST), response);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }

    throw Object.assign(new Error("Not found"), { status: 404 });
  } catch (error) {
    const { status, headers, body } = json({ error: error.message || "Unexpected error" }, statusFor(error));
    const plain = {};

    for (const [key, value] of headers) plain[key] = value;

    response.writeHead(status, plain);
    response.end(body ? await new Response(body).text() : undefined);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Downloader on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
