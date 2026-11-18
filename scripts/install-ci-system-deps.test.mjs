#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const installer = fileURLToPath(new URL("./install-ci-system-deps.sh", import.meta.url));
const action = parse(readFileSync(new URL("../.github/actions/install-ci-system-deps/action.yml", import.meta.url), "utf8"));

const prelude = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(process.env.FAKE_APT_TRACE, JSON.stringify(entry) + "\\n");
`;

// A fake apt toolchain on PATH: privilege escalation, apt-get, dpkg and timeout record what the installer
// asked for and never touch the host. sudo refuses any argument under the real /etc/apt.
function fakeApt(fixture, mirrorHost, mirrorFile) {
	const apt = join(fixture, "apt");
	const bin = join(fixture, "bin");
	mkdirSync(join(apt, "sources.list.d"), { recursive: true });
	mkdirSync(bin);
	writeFileSync(join(apt, "sources.list"), `deb http://${mirrorHost}/ubuntu noble main\n`);
	writeFileSync(join(apt, "sources.list.d", "legacy.list"), `deb http://${mirrorHost}/ubuntu noble main\n`);
	writeFileSync(join(apt, "sources.list.d", "ubuntu.sources"),
		`Types: deb\nURIs: ${mirrorFile ? "mirror+file:" + join(apt, "apt-mirrors.txt") : `http://${mirrorHost}/ubuntu`}\nSuites: noble\nComponents: main\n`);
	if (mirrorFile) {
		writeFileSync(join(apt, "apt-mirrors.txt"),
			`http://${mirrorHost}/ubuntu\tpriority:1\nhttp://archive.ubuntu.com/ubuntu\tpriority:2\nhttp://security.ubuntu.com/ubuntu\tpriority:3\n`);
	}
	// BSD sed needs a separate empty backup suffix, unlike the Linux runner.
	writeFileSync(join(bin, "sudo"), `#!/bin/bash
for arg in "$@"; do
  case "$arg" in /etc/apt/*) exit 97 ;; esac
done
${process.platform === "darwin" ? 'if [ "$1" = sed ] && [ "$2" = -i ]; then shift 2; exec sed -i "" "$@"; fi\nif [ "$1" = sed ] && [ "$2" = -E ] && [ "$3" = -i ]; then shift 3; exec sed -E -i "" "$@"; fi' : ""}
exec "$@"
`, { mode: 0o755 });
	writeFileSync(join(bin, "apt-get"), `${prelude}
const etc = process.env.APT_ETC_DIR;
const source = fs.readFileSync(path.join(etc, "sources.list.d/ubuntu.sources"), "utf8");
const mirrors = source.includes("mirror+file:") ? fs.readFileSync(path.join(etc, "apt-mirrors.txt"), "utf8") : source;
const mirror = mirrors.match(/https?:\\/\\/[^\\s]+/)[0];
const archives = args.find((arg) => arg.startsWith("Dir::Cache::archives="))?.slice("Dir::Cache::archives=".length);
const action = args.includes("update") ? "update" : args.includes("--download-only") ? "download" : "offline";
if (action === "download" && archives) fs.writeFileSync(path.join(archives, "ripgrep_14.1.0-1_amd64.deb"), "deb");
record({ action, mirror, mirrors, archives, args });
`, { mode: 0o755 });
	writeFileSync(join(bin, "dpkg"), `${prelude}
record({ action: "dpkg", args });
process.exit(args[0] === "-i" && process.env.FAKE_DPKG_STATUS ? Number(process.env.FAKE_DPKG_STATUS) : 0);
`, { mode: 0o755 });
	writeFileSync(join(bin, "dpkg-query"), `${prelude}
process.stdout.write(process.env.FAKE_INSTALLED === "1" ? "installed" : "not-installed");
`, { mode: 0o755 });
	writeFileSync(join(bin, "timeout"), `${prelude}
const { spawnSync } = require("node:child_process");
const marker = path.join(process.env.APT_ETC_DIR, "timed-out");
const killAfter = args.shift();
const budget = args.shift();
record({ action: "timeout", killAfter, budget });
const result = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.env.FAKE_FIRST_TRANSFER_TIMES_OUT === "1" && args[0] === "bash" && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, "");
  process.exit(124);
}
`, { mode: 0o755 });
	return { apt, bin };
}

function runInstaller(fixture, { apt, bin }, env = {}, args = ["ripgrep"]) {
	const trace = join(fixture, "trace.jsonl");
	const result = spawnSync("bash", [installer, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APT_ETC_DIR: apt, FAKE_APT_TRACE: trace, ...env },
		encoding: "utf8",
		timeout: 10000,
	});
	const events = existsSync(trace)
		? readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line))
		: [];
	return { result, events };
}

function withFixture(body) {
	const fixture = mkdtempSync(join(tmpdir(), "ci-apt-"));
	try {
		body(fixture);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
}

// senpi#4131, senpi#4552: hosted runners moved from the Azure region mirror to an EC2 region mirror,
// and a fallback that only rewrote azure.archive.ubuntu.com retried the same slow mirror.
for (const mirrorHost of ["azure.archive.ubuntu.com", "us-east-2.ec2.archive.ubuntu.com"]) {
	for (const mirrorFile of [true, false]) {
		test(`a timed-out apt transfer from ${mirrorHost} retries archive.ubuntu.com then installs offline (${mirrorFile ? "mirror file" : "direct sources"})`, () => {
			withFixture((fixture) => {
				const fake = fakeApt(fixture, mirrorHost, mirrorFile);
				const { result, events } = runInstaller(fixture, fake, { FAKE_FIRST_TRANSFER_TIMES_OUT: "1" });
				assert.equal(result.status, 0, result.stderr || result.error?.message);
				assert.deepEqual(events.map((entry) => entry.action),
					["timeout", "update", "download", "timeout", "update", "download", "timeout", "offline"]);
				const transfers = events.filter((entry) => entry.action === "update");
				assert.ok(transfers[0].mirror.includes(mirrorHost));
				assert.equal(transfers[1].mirror, "http://archive.ubuntu.com/ubuntu");
				assert.ok(!transfers[1].mirrors.includes(mirrorHost));
				const budgets = events.filter((entry) => entry.action === "timeout");
				assert.deepEqual(budgets.map((entry) => entry.budget), ["60s", "150s", "60s"]);
				assert.ok(budgets.every((entry) => entry.killAfter === "--kill-after=5s"));
				assert.ok(events.at(-1).args.includes("--no-download"));
				assert.equal(events.at(-1).mirror, "http://archive.ubuntu.com/ubuntu");
				for (const source of ["sources.list", "sources.list.d/legacy.list", "sources.list.d/ubuntu.sources"]) {
					assert.ok(!readFileSync(join(fake.apt, source), "utf8").includes(mirrorHost), source);
				}
			});
		});
	}
}

test("a restored .deb set installs with dpkg and never contacts a mirror", () => {
	withFixture((fixture) => {
		const fake = fakeApt(fixture, "us-east-2.ec2.archive.ubuntu.com", true);
		const cache = join(fixture, "debs");
		mkdirSync(cache);
		writeFileSync(join(cache, "ripgrep_14.1.0-1_amd64.deb"), "deb");
		const { result, events } = runInstaller(fixture, fake, { APT_DEB_CACHE_DIR: cache, FAKE_INSTALLED: "1" });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.deepEqual(events.map((entry) => entry.action), ["dpkg"]);
		assert.deepEqual(events[0].args, ["-i", join(cache, "ripgrep_14.1.0-1_amd64.deb")]);
		assert.match(result.stdout, /from the cached \.deb set/);
	});
});

test("an empty cache downloads into the cache directory and installs from it", () => {
	withFixture((fixture) => {
		const fake = fakeApt(fixture, "us-east-2.ec2.archive.ubuntu.com", true);
		const cache = join(fixture, "debs");
		const { result, events } = runInstaller(fixture, fake, { APT_DEB_CACHE_DIR: cache });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.deepEqual(events.map((entry) => entry.action), ["timeout", "update", "download", "timeout", "offline"]);
		for (const entry of events.filter((event) => event.action !== "timeout")) assert.equal(entry.archives, cache);
		assert.deepEqual(readdirSync(cache).filter((name) => name.endsWith(".deb")), ["ripgrep_14.1.0-1_amd64.deb"]);
	});
});

test("a cached set that does not install is dropped and the packages come from the mirror", () => {
	withFixture((fixture) => {
		const fake = fakeApt(fixture, "us-east-2.ec2.archive.ubuntu.com", true);
		const cache = join(fixture, "debs");
		mkdirSync(cache);
		writeFileSync(join(cache, "stale_1.0_amd64.deb"), "deb");
		const { result, events } = runInstaller(fixture, fake, { APT_DEB_CACHE_DIR: cache, FAKE_DPKG_STATUS: "1" });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
		assert.match(result.stdout, /::warning::The cached \.deb set did not install ripgrep/);
		assert.deepEqual(events.map((entry) => entry.action),
			["dpkg", "dpkg", "timeout", "update", "download", "timeout", "offline"]);
		assert.deepEqual(events[1].args, ["--configure", "-a"]);
		assert.deepEqual(readdirSync(cache).filter((name) => name.endsWith(".deb")), ["ripgrep_14.1.0-1_amd64.deb"]);
	});
});

test("the cache key changes with the runner image and the package set", () => {
	withFixture((fixture) => {
		const fake = fakeApt(fixture, "us-east-2.ec2.archive.ubuntu.com", true);
		const key = (env, packages) => {
			const { result, events } = runInstaller(fixture, fake, env, ["--cache-key", ...packages]);
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(events, []);
			return result.stdout.trim();
		};
		assertKeys(key);
	});
});

function assertKeys(key) {
	const image = { ImageOS: "ubuntu24", ImageVersion: "20261110.1" };
	const base = key(image, ["fd-find", "ripgrep"]);
	assert.match(base, /^key=apt-debs-ubuntu24-20261110\.1-[^-]+-[0-9a-f]{16}$/);
	assert.equal(key(image, ["fd-find", "ripgrep"]), base);
	assert.notEqual(key({ ...image, ImageVersion: "20261117.2" }, ["fd-find", "ripgrep"]), base);
	assert.notEqual(key(image, ["ripgrep"]), base);
}

test("the shared action restores the cache under the installer's key before installing", () => {
	const [keyStep, cacheStep, installStep] = action.runs.steps;
	assert.equal(action.runs.using, "composite");
	assert.match(keyStep.run, /install-ci-system-deps\.sh" --cache-key \$PACKAGES >> "\$GITHUB_OUTPUT"/);
	assert.match(cacheStep.uses, /^actions\/cache@[0-9a-f]{40}$/);
	assert.equal(cacheStep.with.key, `\${{ steps.${keyStep.id}.outputs.key }}`);
	assert.equal(installStep.env.APT_DEB_CACHE_DIR, cacheStep.with.path);
	assert.match(installStep.run, /install-ci-system-deps\.sh" \$PACKAGES$/);
});
