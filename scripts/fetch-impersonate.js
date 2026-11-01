"use strict";

/**
 * Downloads curl-impersonate (Chrome TLS fingerprint) on Linux hosts.
 *
 * Why: the GSRTC edge sits behind a bot filter that 403s OpenSSL TLS
 * handshakes (Render's system curl, Node's fetch) while Windows Schannel gets
 * through. curl-impersonate speaks BoringSSL with a Chrome ClientHello, which
 * the filter accepts.
 *
 * Runs from npm's postinstall. Never fails the build: on download problems the
 * server simply falls back to the system curl.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const VERSION = "v0.6.1";
const ASSET = `curl-impersonate-${VERSION}.x86_64-linux-gnu.tar.gz`;
const URL = `https://github.com/lwthiker/curl-impersonate/releases/download/${VERSION}/${ASSET}`;

const root = path.join(__dirname, "..");
const dir = path.join(root, ".curl-impersonate");
const wrapper = path.join(dir, "curl_chrome116");

function log(line) {
  process.stderr.write(`[curl-impersonate] ${line}\n`);
}

async function main() {
  if (process.env.GSRTC_SKIP_IMPERSONATE === "1") {
    log("skipped (GSRTC_SKIP_IMPERSONATE=1)");
    return;
  }

  if (process.platform !== "linux") {
    log(`skipped (${process.platform} uses the system curl)`);
    return;
  }

  if (process.arch !== "x64") {
    log(`skipped (no prebuilt binary for ${process.arch})`);
    return;
  }

  if (fs.existsSync(wrapper)) {
    log("already present");
    return;
  }

  fs.mkdirSync(dir, { recursive: true });

  const response = await fetch(URL);
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);

  const tarball = path.join(dir, ASSET);
  fs.writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));

  execFileSync("tar", ["-xzf", tarball, "-C", dir], { stdio: "inherit" });
  fs.rmSync(tarball, { force: true });

  for (const file of ["curl_chrome116", "curl-impersonate-chrome", "curl-impersonate-ff"]) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) fs.chmodSync(target, 0o755);
  }

  log(`installed ${path.relative(root, wrapper)}`);
}

main().catch((error) => {
  log(`unavailable (${error.message}) - falling back to the system curl`);
  process.exit(0);
});
