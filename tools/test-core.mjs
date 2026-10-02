/**
 * Tests for the fixes, in the project's own style: no framework, no
 * dependencies, plain `check()` and an exit code.
 *
 * They exist because each of these was a bug that no other check could see.
 *
 * - `bestVariant` scored each variant as `pixels || bandwidth`, which put
 *   pixels and bits per second in the same column. `tools/test-worker.mjs` does
 *   not touch HLS at all, and the flattened build does not care what a function
 *   computes, so nothing was watching.
 * - `concatStream` read one chunk per segment. It is only reachable with a real
 *   playlist, and the only other test that goes near it is one HTTP probe.
 * - The credential leak needed a server standing in for the other host.
 * - `/api/media?id=` had never run, which is the only kind of bug that a passing
 *   test suite cannot find.
 *
 * The servers are local and started here, so nothing in this file needs the
 * internet. The one exception is named in the test that uses it.
 */
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { PassThrough } from "node:stream";

import { choose, chooseWithoutAsking, size, interactive } from "../bin/select.mjs";

/* A test that hangs is worse than one that fails: it says nothing, and it stops the
   whole suite from finishing. This was not hypothetical — reintroducing the
   read-one-chunk bug made `concatStream`'s `pull` never return, because nothing
   marked the stream finished, and the test sat there until the runner was killed.

   So anything that waits on a body waits with a deadline, and a deadline that
   passes is a failure with a message that says what was expected. */
const CON_TIEMPO = 20000;

async function withDeadline(promise, label) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), CON_TIEMPO);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

import { bestVariant, platformOf } from "../src/core.mjs";
import { isPublic } from "../src/universal.mjs";
import { handleMedia } from "../src/api.mjs";
import { extractFacebookId } from "../src/platforms/facebook.js";
import { extractTikTokVideoId } from "../src/platforms/tiktok.js";

let failures = 0;
let total = 0;

function check(name, ok, got = "", want = "") {
  total += 1;

  if (ok) {
    console.log(`   ${name}`);
  } else {
    failures += 1;
    console.log(`   ${name}  ->  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** A server whose behaviour is decided by the test, and which records what it got. */
async function startServer(handler) {
  const received = [];

  const server = createServer((req, res) => {
    received.push({ url: req.url, cookie: req.headers.cookie ?? null, range: req.headers.range ?? null });
    handler(req, res);
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  return {
    received,
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

const master = (lines) => ["#EXTM3U", ...lines].join("\n");

// ── bestVariant ───────────────────────────────────────────────────────────

/* A mixed master is the case that was broken: one entry declares a width and the
   other does not, and the old scoring compared 480 against 4220000. */
check(
  "mejorVariante: a width beats a higher bitrate that declares none",
  bestVariant(master([
    "#EXT-X-STREAM-INF:BANDWIDTH=155000,RESOLUTION=1920x1080,CODECS=\"avc1.64001F\"",
    "1080p.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=4220000,CODECS=\"avc1.64001F\"",
    "sin.m3u8",
  ])) === "1080p.m3u8",
);

check(
  "mejorVariante: the largest width wins when they all declare one",
  bestVariant(master([
    "#EXT-X-STREAM-INF:BANDWIDTH=3063000,RESOLUTION=1280x720,CODECS=\"avc1.64001F\"", "720p.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=464000,RESOLUTION=480x270,CODECS=\"avc1.42C01E\"", "270p.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=1797000,RESOLUTION=960x540,CODECS=\"avc1.64001F\"", "540p.m3u8",
  ])) === "720p.m3u8",
);

check(
  "mejorVariante: order in the file does not matter",
  bestVariant(master([
    "#EXT-X-STREAM-INF:BANDWIDTH=155000,RESOLUTION=480x270,CODECS=\"avc1.42C01E\"", "a.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1920x1080,CODECS=\"avc1.640028\"", "c.m3u8",
  ])) === "c.m3u8",
);

check(
  "mejorVariante: bitrate decides only when nothing declares a width",
  bestVariant(master([
    "#EXT-X-STREAM-INF:BANDWIDTH=155000,CODECS=\"avc1\"", "a.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=3200000,CODECS=\"avc1\"", "b.m3u8",
  ])) === "b.m3u8",
);

check(
  "mejorVariante: HEVC is skipped for something a browser can play",
  bestVariant(master([
    "#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=1920x1080,CODECS=\"hvc1\"", "hevc.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,CODECS=\"avc1.64001F\"", "avc.m3u8",
  ])) === "avc.m3u8",
);

check("mejorVariante: an empty master has no best", bestVariant("#EXTM3U") === null);

// ── isPublic ───────────────────────────────────────────────────────────────

check("isPublic: rejects 127.0.0.1", isPublic("http://127.0.0.1/x") === false);
check("isPublic: rejects 10.0.0.1", isPublic("http://10.0.0.1/x") === false);
check("isPublic: rejects 192.168.1.1", isPublic("http://192.168.1.1/x") === false);
check("isPublic: rejects loopback written as an integer", isPublic("http://2130706433/x") === false);
check("isPublic: rejects loopback written short", isPublic("http://127.1/x") === false);
check("isPublic: rejects loopback in hex", isPublic("http://0x7f.1/x") === false);
check("isPublic: rejects IPv4 written as IPv6", isPublic("http://[::ffff:127.0.0.1]/x") === false);
check("isPublic: rejects the unspecified address", isPublic("http://0.0.0.0/x") === false);
check("isPublic: rejects .local", isPublic("http://printer.local/x") === false);
check("isPublic: rejects a non-http scheme", isPublic("javascript:alert(1)") === false);
check("isPublic: rejects a file scheme", isPublic("file:///etc/passwd") === false);
check("isPublic: accepts an ordinary address", isPublic("https://example.com/x") === true);

// ── The credential leak ─────────────────────────────────────────────────────

/* A link whose *text* mentions the platform but whose host is someone else's used
   to be read as that platform, and the extractor put the link as pasted into the
   list of candidates it fetches with the session cookie attached. */
const forgeries = [
  "https://evil.example/facebook.com/reel/123456789",
  "https://evil.example/?x=facebook.com/reel/123456789",
  "https://evil.example/facebook.com/evil/page/videos/123456789/",
  "https://evil.example/tiktok.com/@user/video/7234567890123456789",
  "https://evil.example/tiktok.com/@user/photo/7234567890123456789",
];

for (const link of forgeries) {
  const id = link.includes("facebook") ? extractFacebookId(link) : extractTikTokVideoId(link);

  check(`a link on another host is not ${link.includes("facebook") ? "Facebook" : "TikTok"}: ${link.slice(0, 58)}`, id === null, id, null);
}

/* And the real ones still work, because a fix that breaks the feature is not a
   fix. This is the half that is easy to leave out. */
const genuine = [
  ["https://www.facebook.com/reel/123456789012345", "123456789012345"],
  ["https://www.facebook.com/watch/?v=123456789012345", "123456789012345"],
  ["https://www.facebook.com/miba.page/videos/123456789012345/", "123456789012345"],
  ["https://m.facebook.com/reel/123456789012345", "123456789012345"],
  ["https://fb.watch/abc123XYZ", "abc123XYZ"],
];

for (const [link, id] of genuine) {
  const real = extractFacebookId(link);
  check(`a real Facebook link still resolves: ${link.slice(0, 52)}`, real === id, real, id);
}

check("a real TikTok link still resolves", extractTikTokVideoId("https://www.tiktok.com/@user/video/7234567890123456789") === "7234567890123456789");
check("a TikTok short form still resolves", extractTikTokVideoId("https://m.tiktok.com/@user/photo/7234567890123456789") === "7234567890123456789");

/* The gate both extractors now use, asserted directly. */

check("platformOf: a Facebook-looking string on another host is not facebook", platformOf("https://evil.example/facebook.com/reel/123456789") !== "facebook");
check("platformOf: a TikTok-looking string on another host is not tiktok", platformOf("https://evil.example/tiktok.com/@u/video/123") !== "tiktok");
check("platformOf: the real host is facebook", platformOf("https://www.facebook.com/reel/123456789") === "facebook");

// ── /api/media routing ──────────────────────────────────────────────────────

const pedir = async (query) => {
  const url = new URL(`https://x.test/api/media${query}`);
  const response = await handleMedia(new Request(url.href), url);
  return { status: response.status, body: await response.text(), response };
};

const noUrl = await pedir("?id=corto");
check("/api/media: a short id is refused on its own terms", noUrl.status === 400 && /video id/.test(noUrl.body), noUrl.body, "a video id error");

const privateRes = await pedir("?url=" + encodeURIComponent("http://127.0.0.1/x.mp4"));
check("/api/media: a private address is refused", privateRes.status === 400 && /not valid/.test(privateRes.body), privateRes.body, "not valid");

const integer = await pedir("?url=" + encodeURIComponent("http://2130706433/x.mp4"));
check("/api/media: loopback as an integer is refused", integer.status === 400, integer.body, "400");

const scheme = await pedir("?url=javascript:alert(1)");
check("/api/media: a javascript: url is refused", scheme.status === 400, scheme.body, "400");

const noRef = await pedir("?url=" + encodeURIComponent("https://example.com/x.mp4"));
check("/api/media: an address with no referer asked for is refused", noRef.status === 400, noRef.body, "400");

// ── HLS: segments are read whole, and only from public addresses ────────────

/* One segment, one megabyte, served locally. `concatStream` used to read a
   single `read()` and stop, so this came out as the first chunk instead of the
   whole thing. */
const UN_MIB = 1024 * 1024;

/* The playlist has to be served from a host that `isPublic` accepts, and the only
   way to have a server in this file is on the loopback — which the filter, quite
   correctly, refuses. A hostname that resolves to 127.0.0.1 and is not itself
   private-looking is the way out.

   That gap is real and worth knowing about: it is the same thing
   `127.0.0.1.nip.io` would be, except that one is caught because its *name* starts
   with `127.`. A filter that reads hostnames cannot see where a name points, so
   this is a documented limit rather than a solved problem — and it is why the
   comment in `universal.mjs` says the wall on Cloudflare is `fetch` itself.

   The test skips rather than fails if the name does not resolve, because a suite
   that needs the internet to run offline is worse than one that admits it did not. */
const ALIAS = "localtest.me";

/* Family 4 on purpose: the name has both an A and an AAAA record, and the server
   below listens on IPv4 only. Without the hint this resolves to `::1` and the test
   skips itself for the wrong reason. */
/* `lookup` answers with an object, so the address has to be taken out of it: a
   `/^127\./.test(result)` on the object tested "[object Object]". */
const resolved = await lookup(ALIAS, 4).then((r) => r.address).catch(() => null);

if (resolved && /^127\./.test(resolved) && isPublic(`http://${ALIAS}/x`)) {
  const cdn = await startServer((req, res) => {
  if (req.url === "/v.m3u8") {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    res.end(["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXTINF:4.0,", "/seg0.ts", "#EXTINF:4.0,", "/seg1.ts", "#EXT-X-ENDLIST"].join("\n"));
    return;
  }

  res.writeHead(200, { "content-type": "video/mp2t" });
  res.end(Buffer.alloc(UN_MIB, 0x47));
});

  const hlsBody = await withDeadline(
    pedir("?url=" + encodeURIComponent(`http://${ALIAS}:${cdn.port}/v.m3u8`)),
    "the HLS stream never finished",
  );
const bytesHls = hlsBody.body.length;

  check(
    "HLS: every segment is read to the end",
  hlsBody.status === 200 && bytesHls === UN_MIB * 2,
  `${hlsBody.status} and ${bytesHls} bytes`,
  `200 and ${UN_MIB * 2} bytes`,
);
  check("HLS: both segments were requested", cdn.received.filter((r) => r.url.endsWith(".ts")).length === 2, cdn.received.length, 3);

  await cdn.close();

/* A playlist served from a host that passes the filter, naming a segment that does
   not. The guard on the request only ever looked at the playlist's own address;
   the segment addresses come out of the body, and they used to be fetched with no
   check of their own. */
  const secret = "CONTENIDO-PRIVADO-DE-LOCALHOST";

  const internalServer = await startServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(secret);
});

  const withPrivateSegment = await startServer((req, res) => {
  res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
  res.end(["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXTINF:4.0,", `${internalServer.url}/secreto`, "#EXT-X-ENDLIST"].join("\n"));
});

  const filtered = await pedir("?url=" + encodeURIComponent(`http://${ALIAS}:${withPrivateSegment.port}/v.m3u8`));

  check(
    "HLS: a segment on a private address is not fetched",
  !filtered.body.includes(secret),
  filtered.body.slice(0, 60),
  "no private content",
);
  check("HLS: the private address was never requested", internalServer.received.length === 0, internalServer.received.length, 0);

  await internalServer.close();
  await withPrivateSegment.close();
} else {
  console.log(`   (skipped: ${ALIAS} does not resolve to loopback here, so the read-to-the-end test cannot run)`);
}

/* And the rule still says the same thing about the values it always rejected, so
   none of the above quietly widened it. */
check("isPublic: the loopback still comes back false", isPublic("http://127.0.0.1/x") === false);
check("isPublic: a hostname spelled 127.x is refused by name", isPublic("http://127.0.0.1.nip.io/x") === false);

/* ── the CLI: choosing and measuring ───────────────────────────────────────── */

/* The size string is on the progress bar of every download, and it was wrong in
   both directions before it had a test: "1.5 undefined" and "24 kB" for 24 MB. */
for (const [bytes, expected] of [
  [0, ""], [1, "1 B"], [940, "940 B"], [1000, "1.0 kB"], [1500, "1.5 kB"],
  [1240000, "1.2 MB"], [24100000, "24 MB"], [1500000000, "1.5 GB"],
]) {
  check(`size: ${bytes} reads as ${expected || "(nothing)"}`, size(bytes) === expected, size(bytes), expected);
}

/* A piped run must never wait for an answer that is not coming. */
const plan = [
  { kind: "video", name: "a.mp4", hls: false },
  { kind: "audio", name: "b.mp3", hls: false },
  { kind: "image", name: "c.jpg", hls: false },
];

const noTerminal = await choose(plan, { input: new PassThrough(), output: new PassThrough() });

check("no terminal: takes everything without asking", JSON.stringify(noTerminal) === "[0,1,2]", noTerminal, "0,1,2");
check("interactive(null) is false", interactive(null) === false, interactive(null), false);

/* The prompt, with a terminal on both ends. Answering needs a readline that is
   already listening, which is what the tick is for. */
function tty() {
  const s = new PassThrough();

  s.isTTY = true;
  s.columns = 100;

  return s;
}

async function responder(text) {
  const input = tty();
  const output = tty();

  const promise = choose(plan, { input, output });

  await new Promise((r) => setImmediate(r));
  input.write(text + "\n");

  return promise;
}

for (const [response, expected, label] of [
  ["1", [0], "one number"],
  ["2 3", [1, 2], "several numbers"],
  ["1-3", [0, 1, 2], "a range"],
  ["3,1", [0, 2], "out of order, sorted"],
  ["all", [0, 1, 2], "all"],
  ["", [0, 1, 2], "enter alone"],
  ["q", null, "q quits"],
  ["9\n1", [0], "out of range, asks again"],
  ["abc\n2", [1], "a letter, asks again"],
]) {
  const picked = await responder(response);

  check(`prompt: ${label}`, JSON.stringify(picked) === JSON.stringify(expected), picked, expected);
}

for (const [options, expected, label] of [
  [{ only: "audio" }, [1], "--only audio"],
  [{ only: "video,image" }, [0, 2], "--only video,image"],
  [{ index: "2" }, [1], "--index 2"],
  [{ index: "1,3" }, [0, 2], "--index 1,3"],
  [{}, [0, 1, 2], "no options, everything"],
  [{ index: "9" }, "throws", "a number that is not there"],
  [{ only: "audio", index: "1" }, "throws", "two ways of choosing"],
]) {
  let picked;

  try {
    picked = chooseWithoutAsking(plan, options);
  } catch {
    picked = "throws";
  }

  check(`flags: ${label}`, JSON.stringify(picked) === JSON.stringify(expected), picked, expected);
}

/* `--ask` has to ask through a pipe, because that is the only way to tell whether
   the flag reaches readline. And the list is the caller's job now, not this
   module's, so asking twice must not print it twice. */
let printedCount = 0;
const countedOutput = new PassThrough();

countedOutput.on("data", (c) => { printedCount += (c.toString().match(/1\) video/g) ?? []).length; });
countedOutput.isTTY = true;
countedOutput.columns = 100;

const askInput = new PassThrough();

askInput.isTTY = true;

const forcedPrompt = choose(plan, { input: askInput, output: countedOutput, forzar: true });

await new Promise((r) => setImmediate(r));
askInput.write("all\n");

const forced = await forcedPrompt;

check("--ask asks through a pipe", JSON.stringify(forced) === "[0,1,2]", forced, "0,1,2");
check("--ask does not print the list itself", printedCount === 0, printedCount, 0);

console.log(`\n  ${total - failures}/${total} checks passed`);

if (failures) process.exit(1);
