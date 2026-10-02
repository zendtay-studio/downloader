<img src="https://raw.githubusercontent.com/zendtay-studio/downloader/gh-pages/images/og.png" alt="Downloader" />

# Downloader

Paste a link, get the video, the audio or the photo. It serves its own API and its
own web page, and it runs in two places: a local Node server and a published
Cloudflare Worker.

**21 platforms:** TikTok, Instagram, Threads, YouTube (videos and playlists),
Pinterest, Pornhub, Facebook, X, OK, Bluesky, Dailymotion, Snapchat, Kwai,
Spotify, Reddit, SoundCloud, Vimeo, Streamable, Rutube, Bilibili and Loom. Plus
anything that is not a known platform, which goes through a generic extractor.

Three sites that other downloaders do support are deliberately absent: VK, Tumblr
and Newgrounds. VK's public API answers `error_code: 5`, which means it wants an
authorisation token; Tumblr and Newgrounds both answer a bot challenge to anything
that is not a logged-in browser. Adding a platform that cannot answer is worse than
not listing it, so they are not here.

Three of the twenty-one serve HLS instead of a single file — Vimeo, Rutube and
Bilibili's video track — and the browser is handed the playlist rather than a
file. That is not a workaround: joining them needs `ffmpeg`, which a Worker does
not have. Bilibili serves its audio as a separate track from its video, so both are
offered as what they are.

No dependencies. No account. There is a build step, but it is one command and
it only exists to turn `src/` into the single file you paste into Cloudflare.

---

## Install the CLI

```sh
git clone https://github.com/zendtay-studio/downloader.git && cd downloader && npm i -g .
```

or, which does the same thing and checks it worked:

```sh
git clone https://github.com/zendtay-studio/downloader.git
cd downloader
npm run i          # or ./install.sh
```

Either way you get a `ddd` command. There are no dependencies, so this is the
whole install — nothing to build, no lockfile, no `node_modules` to keep in sync.

`npm run i` is the same install plus four things npm will not do on its own: it
reads the command's name and the Node version out of `package.json` rather than
carrying its own, so nothing here can drift from the package; it runs the command
afterwards and fails if it does not answer; and it tells you when the directory npm
wrote it into is not on your `PATH`. That last one is the step that ruins an
install silently — npm says `added 1 package`, the file is there, and every shell
still answers `ddd: command not found`.

The clone is not ceremony, though not for the reason it looks like. Both this and
`npm i -g github:zendtay-studio/downloader` leave a **symlink**, not a copy —
npm treats a path or a git URL as something to point at rather than something to
copy. The difference is what it points at. This one points at your checkout,
which is a directory that stays put; the GitHub one points at a temporary clone
inside npm's cache, and that clone is deleted — leaving a command that reports
`No such file or directory` with nothing at install time to say so.

So this install needs the checkout to keep existing. Delete `downloader/` and
`ddd` dangles.

For an install that survives that, ask for a copy instead:

```sh
npm run i -- --copy
```

That is `npm pack` followed by installing the tarball, which really does copy. After
it you can delete the checkout and `ddd` still works. The cost is that the copy
does not change when the checkout does, so it has to be repeated after a `git pull`.

```sh
ddd https://www.tiktok.com/@someone/video/1234567890
```

Files land in the **current directory**. A link that resolves to several files
gets all of them.

**Quote any link containing `&`.** This one bites quietly:

```sh
ddd https://www.tiktok.com/@someone/video/123?is_from_webapp=1&device=pc
```

The shell does not know what a link is, so it reads the `&` as a separator.
Everything up to it becomes a background job, which prints something like
`[1] 50823` — a job number and a process ID, not output from `ddd` — and the
rest, `device=pc`, is read as an assignment and does nothing at all. No error
anywhere, and the prompt comes straight back.

Worse, the half that does run is usually still a valid link, so you get the
wrong download instead of no download. Quote it:

```sh
ddd "https://www.tiktok.com/@someone/video/123?is_from_webapp=1&device=pc"
```

Paste the link inside single quotes instead if it contains anything the shell
might touch — it never has to be unquoted again.

You need [Node.js](https://nodejs.org) 20 or newer. Check with `node -v`.

To remove it:

```sh
npm uninstall -g down-zty
```

<details>
<summary>Working on the CLI itself</summary>

Neither install above copies the checkout, so a `git pull` changes the repository
and not the installed version. That is right for using the CLI and wrong for
changing it.

If you are working on the code, `npm link` points the global command at the
checkout, so a save is a save and there is nothing to reinstall after any change:

```sh
git clone https://github.com/zendtay-studio/downloader.git
cd downloader
npm link
```

After that `git pull` is the whole update. `npm unlink -g down-zty` undoes it.

If your shell was already holding the old path — which happens after any
reinstall, since bash remembers where it last found a command — run:

```sh
hash -r
```

</details>

## Run it locally

You need Node 20 or newer. No install step, because there are no dependencies.

```sh
git clone https://github.com/zendtay-studio/downloader.git
cd downloader
npm start
```

Open <http://localhost:3000>. The page and the API are both on that port, so the
local server behaves like the published one.

```sh
PORT=8080 npm start          # another port
HOST=127.0.0.1 npm start     # only reachable from this machine
```

`tools/serve.mjs` is a thin adapter: all the logic is in `src/api.mjs`, which
returns standard `Response` objects and is the exact same code that runs on
Cloudflare. The server only translates `node:http` to `Response` and back.

### Use the CLI from a clone

Without installing anything:

```sh
node bin/cli.mjs "https://www.tiktok.com/@someone/video/1234567890"
```

---

## Deploy to Cloudflare

The Worker is **one file** with no dependencies and no build step to deploy.

### The quick way, no tools

1. `npm run build` — this writes `worker.js`.
2. Open the Cloudflare dashboard → **Workers & Pages** → your Worker → **Edit
   code**.
3. Select all the existing code, paste the whole of `worker.js`, press **Deploy**.

You are done. The Worker starts serving immediately on its `*.workers.dev` URL.

There is nothing to configure and nothing to build on Cloudflare's side. If you
see an error the moment it deploys, the file that got pasted was truncated.

### The wrangler way

```sh
npm run build
npx wrangler deploy
```

`wrangler.toml` already points `main` at `worker.js`, has no `nodejs_compat`
(it is not needed: nothing under `src/` imports from Node), and turns on
observability so `console.log` output shows up in the log stream.

First time only:

```sh
npx wrangler login
```

### Check it works

```sh
curl "https://<your-worker>.workers.dev/api/resolve?url=https://www.tiktok.com/@someone/video/1234567890"
```

You should get JSON with an `items` array. A `429` or an empty list means the
platform is refusing that IP, not that your Worker is broken — see
[Limits](#limits-and-why-things-fail).

---

## How the page is hosted

**The web page is not inside the Worker.** The Worker fetches `index.html` from
the `gh-pages` branch of this repository and caches it in Cloudflare for an
hour. The page URL is `PAGE_URL` in `src/worker-entry.js`.

That means you can update the page without redeploying anything:

```sh
git checkout gh-pages
# edit index.html, video.json or images/og.png
git commit -am "new background video"
git push
```

Within an hour the Worker serves the new page. To make it immediate, deploy the
Worker again — a redeploy clears the cache.

The same is true of `/images/og.png`, the preview image.

Keep `index.html`, `video.json` and `images/` on `gh-pages`. Everything else —
the sources and the tools — stays on the default branch.

---

## The API

| Route | What it does |
|---|---|
| `/api/resolve?url=` | Lists the files behind a link. |
| `/api/media?url=&ref=` | Serves the file with the `Referer` its CDN demands. |
| `/api/media?url=&kind=` | Serves an HLS stream. If the segments turn out to be byte ranges of one MP4, it serves the whole thing in one read. |
| `/api/media?id=` | Redirects to the direct URL of a YouTube video. |
| `/api/download?url=&index=` | The file, with its real filename. |
| `/images/og.png`, `/og-image.png` | The preview image, from the repository. |
| `/index.html` | The same page as `/`. |
| `/` | The page, from the repository. |

All responses are JSON except `/images/og.png` and the media routes.

`/api/resolve` returns something like:

```json
{
  "source": "https://www.tiktok.com/@someone/video/1234567890",
  "platform": "tiktok",
  "items": [
    {
      "index": 0,
      "kind": "video",
      "type": "Video",
      "brand": "TikTok",
      "extension": "MP4",
      "name": "TikTok video.mp4",
      "size": "12.5 MB",
      "media": "https://…"
    }
  ]
}
```

`media` is the direct URL whenever there is one, and `proxy` is a separate
endpoint for the two cases where there is not: platforms whose CDN refuses the
file without a `Referer` of their own, and HLS streams, which a browser cannot
fetch segment by segment. Fall back to `proxy` when `media` is `null` or the
request fails.

`media` is `null`, not missing, on a YouTube playlist item that has not been
measured yet — there are 50 subrequests and a long list has more items than
that. Those items carry `lazy: true` and their `proxy` points at
`/api/media?id=…`, which resolves the video and answers with a 302 to the real
direct URL, so the link starts working as soon as it is asked for.

A YouTube playlist also returns a `playlist` object, and a link that only partly
resolves returns a `warning` string next to the items.

---

## Repository layout

What you edit by hand — the page, the background list, the Worker you paste into
Cloudflare — stays **in the root**, because that is where you look for it.
Everything else lives in a folder, sorted by what it is for.

```
index.html      the whole page: HTML, CSS and JS in one file
video.json      the background videos the picker offers
worker.js       GENERATED by `npm run build`, and not in git: run the
                  build before deploying, and before `npm test`

images/         every image the page serves
  og.png          the preview image, which the Worker reads from the repository
  icon-192.png    the installable app's icon
  icon-512.png      "
  icon-maskable.png  " padded to 80%, so a rounded-corner mask cannot crop it

site.webmanifest   what makes the page installable as a window of its own

src/            the server, one file per platform
  core.mjs       shared: HTTP, cookies, errors, the subrequest budget, naming
  dispatch.mjs     the platform table and the loop that walks it
  platforms/     one file per site, 21 in all
    tiktok.js        the patterns, the requests and how the answer is read
    youtube.js       …and nothing that is not about that one site
    instagram.js
    …
  universal.mjs   the extractor for sites that are not a known platform
  api.mjs         the core of the API. Returns standard Response objects
  worker-entry.js the only file that knows Cloudflare exists

tools/          development tools
  build.mjs         joins src/ into worker.js
  og.mjs            writes og.png, and --check fails if it is stale
  serve.mjs         the Node server for local work
  test-worker.mjs   tests the Worker without deploying it
  scripts-inline.mjs  checks that the page's JS parses
  styles-inline.mjs   checks that the page's stylesheet braces balance
  syntax.mjs          node --check over every JS file, plus the module links
  imports.mjs        every name a platform uses is one it imported
  status.mjs          every error-carrying throw has to answer with a 4xx

bin/cli.mjs     downloads from the terminal. The only thing that touches a disk
wrangler.toml   deployment config
LICENSE         Apache-2.0
```

The files in `src/` are kept separate while you work on them, but what gets
deployed is a single file you can paste as-is into the Cloudflare dashboard.
`tools/build.mjs` is what joins them.

**Adding a platform is one file.** Write `src/platforms/<sitio>.js`, give it a
`detect<Sitio>(source)` that returns `{files, prefix, referer}` — or `null` when
the link is not its own — and add one line to the table in `src/dispatch.mjs`.
Nothing else has to be touched, and no other platform can break, because they
share nothing but `core.mjs`.

Nothing under `src/` imports from `node:*` on purpose, so the same code loads in
Node and in Workers. The one thing that needs a filesystem lives in
`bin/cli.mjs`, which stays out of the Worker for the same reason.

`worker.js` is generated. Editing it directly works until the next build, and
then your change is gone without warning. Change `src/` and run `npm run build`.

---

## Develop

```sh
npm run build     # src/ -> worker.js
npm start         # local server on :3000
npm test          # exercise the Worker without deploying it
npm run check     # build, error statuses, syntax, tests, and the page's JS and CSS
```

`npm test` runs the real `worker.js` in-process and checks routing, error paths,
security headers, and that the proxy URLs come back absolute. It needs no
network and no deploy. To check a live link end to end, use the CLI:

```sh
node bin/cli.mjs "https://www.tiktok.com/@someone/video/1234567890"
```

Building twice in a row gives the same `worker.js` byte for byte. That is on
purpose: it is what lets you diff one deployment against the next and see only
what actually changed.

---

## Limits, and why things fail

Everything in this section is about Cloudflare's shared IPs, not about your code.

### YouTube rate limits

YouTube rate-limits by IP, and Cloudflare Workers IPs are on the list that gets
cut off first: they are not your IP, they are a Worker's, and many Workers leave
through the same ones. The symptom is a `429` that does not depend on the video —
it happens to all of them at once — and it never appears locally, because at
home you go out through a home IP.

Four things the code does to survive it, and one it cannot:

| | |
|---|---|
| One request fewer | Resolving a video no longer scrapes the `/watch` page: it uses the public InnerTube key, which is inside YouTube's own bundle. That HTML was the first thing to get a 429 and served no other purpose. |
| No hammering | Failures are cached for 30 s. A 429 used to mean a fresh call to YouTube every time somebody retried, which is exactly what extends the limit. |
| Retry what it says | If there is a `Retry-After`, it waits that long, up to 5 s. It used to retry at a flat 900 ms, straight against what was asked. The cap is deliberate and it is a compromise: honouring a `Retry-After: 300` literally would hold a Worker request open for five minutes, and a request that long is killed before it finishes waiting. The failure is cached for 30 s, which is what actually keeps the pressure off. |
| Last good result | If a link resolved recently and fails now, the previous answer is returned. These links expire in days, not minutes. |
| **What it cannot** | **The limit itself.** It is YouTube seeing Cloudflare's IP. If it still happens after deploying, the answer is the paid plan or waiting for the window to open. |

The error says so, so nobody has to guess:

> YouTube is rate-limiting requests from this server. It is not the video: it is
> Cloudflare's IP, which is shared between many Workers and gets cut off first.
> Wait a few minutes and try again.

### Subrequests

In a Cloudflare Worker every outbound request is a **subrequest**, and the free
plan allows **50 per request** (the paid plan allows 1000). Going over does not
produce a platform error: Cloudflare kills the whole request and the user sees a
silent failure.

So `core.mjs` keeps a running budget that `dispatch()` resets on every request — the
isolate is reused, and without resetting it the second request from a user would
inherit the first one's spending — and fans of URLs are checked before spending
them. Measured on the test links:

| | Before | Now |
|---|---|---|
| Pornhub album | 61 requests | **3** |
| Snapchat highlight | 61 | **49** |
| YouTube playlist | ~120 | **34** |
| Reddit video (HLS) | 51 | **1** |

The highlight sits at 49 of 50 because it has 28 items to measure and measuring
one is one request: they do not all fit, and the ones left out appear without a
size. That is the right trim, not an overflow — `spendSubrequest()` never lets it
past 50, and when the budget runs out the resolver delivers what it has instead
of blowing up. The other three are fixed by making fewer requests.

The album and the Reddit video are not fixed by trimming: they are fixed by doing
less work. The album page already contains the photos at full size, and the
Reddit video's 50 "segments" are byte ranges of the **same** 53 MB MP4, so it is
served whole in a single read.

### CPU time

The free plan allows 10 ms of CPU per request against 30 s on the paid plan.
Resolving a link hits the platform three or five times, and parsing 550 KB of
Pornhub or TikTok HTML already eats into that. If you see error `1102`, the fix
is not the code: it is the paid plan.

### Facebook needs a session

Facebook is the one platform here that serves no video URL at all to a client
without a session. A reel behind a login comes back as a JavaScript shell with
nothing in it — no `og:video`, no payload, no `.mp4` anywhere in 470 KB of HTML —
and no combination of URL shapes or user agents changes that. The link is
recognised and the failure is reported accurately, but from a Cloudflare Worker
it usually will not resolve.

A session cookie in the `FB_COOKIE` secret is the way in:

```sh
npx wrangler secret put FB_COOKIE     # value: "c_user=...; xs=..."
```

It is optional and nothing changes when it is not set.

### Age gates

Platform errors are rewritten into short messages, but the ones the resolver
marks as explained arrive as they are. A Pornhub failure from a Worker normally
says:

> Pornhub returned the age gate instead of the content. It is usually the IP:
> datacenter IPs (a Worker's) are on that list, and yours at home is not.

That one is not fixable in code: it is Pornhub seeing Cloudflare's IP. The same
link works locally, which is why the failure only appears once published. An age
cookie in the `PH_COOKIE` secret can be used to try to skip it:

```sh
npx wrangler secret put PH_COOKIE     # value: "age_verified=1; ..."
```

If the secret does not exist, the resolver carries on working: the cookie is
optional.

---

## License

Apache-2.0
