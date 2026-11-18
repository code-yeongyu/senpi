#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install-ci-system-deps.sh", import.meta.url));

// Shims stand in for sudo, timeout, apt-get and sleep so the script runs unprivileged and offline.
// apt-get fails its first FAIL_DOWNLOADS download attempts (an 'update' call starts each attempt) and logs every call.
function setup(failDownloads, attemptSeconds = 1) {
	const dir = mkdtempSync(join(tmpdir(), "ci-deps-"));
	const bin = join(dir, "bin");
	const etc = join(dir, "etc");
	mkdirSync(bin);
	mkdirSync(join(etc, "sources.list.d"), { recursive: true });
	writeFileSync(join(etc, "apt-mirrors.txt"), "http://azure.archive.ubuntu.com/ubuntu/\n");
	const shim = (name, body) => {
		writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	shim("sudo", 'exec "$@"');
	shim("timeout", 'while [ "${1#-}" != "$1" ]; do shift; done; shift; exec "$@"');
	shim(
		"apt-get",
		[
			`log=${JSON.stringify(join(dir, "apt.log"))}`,
			`count=${JSON.stringify(join(dir, "updates"))}`,
			'echo "$*" >> "$log"',
			'case " $* " in *" update "*) n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$count";; esac',
			'n=$(cat "$count" 2>/dev/null || echo 0)',
			'case " $* " in *" --no-download "*) exit 0;; esac',
			`case " $* " in *" update "*) c=$(cat ${JSON.stringify(join(dir, "clock"))} 2>/dev/null || echo 1000); echo $(( c + ${attemptSeconds} )) > ${JSON.stringify(join(dir, "clock"))};; esac`,
			`if [ "$n" -le ${failDownloads} ]; then echo "Temporary failure resolving 'archive.ubuntu.com'" >&2; exit 100; fi`,
			"exit 0",
		].join("\n"),
	);
	const clock = JSON.stringify(join(dir, "clock"));
	shim("date", `cat ${clock} 2>/dev/null || echo 1000`);
	shim("sleep", `echo "$1" >> ${JSON.stringify(join(dir, "sleeps"))}\nc=$(cat ${clock} 2>/dev/null || echo 1000); echo $(( c + $1 )) > ${clock}`);
	const run = () =>
		spawnSync("bash", [script, "qemu-user-static"], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APT_ETC_DIR: etc },
		});
	const read = (name) => {
		try {
			return readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
	return { dir, etc, run, read };
}

test("#given DNS fails on the Azure mirror and the first two archive attempts #when deps install #then it backs off, succeeds on the next attempt and installs", (t) => {
	const env = setup(3);
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));
	const result = env.run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(env.read("sleeps"), ["30", "60"]);
	assert.equal(env.read("updates")[0], "4");
	assert.ok(env.read("apt.log").some((line) => line.includes("--no-download install -y qemu-user-static")));
	assert.match(readFileSync(join(env.etc, "apt-mirrors.txt"), "utf8"), /^http:\/\/archive\.ubuntu\.com\/ubuntu\/$/m);
});

test("#given DNS stays down through every attempt #when deps install #then it stops after the bounded retries with exit 100 and never installs", (t) => {
	const env = setup(99);
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));
	const result = env.run();
	assert.equal(result.status, 100);
	assert.deepEqual(env.read("sleeps"), ["30", "60", "120"]);
	assert.equal(env.read("updates")[0], "5");
	assert.match(result.stdout, /::error::APT transfer failed after retries via archive\.ubuntu\.com/);
	assert.ok(!env.read("apt.log").some((line) => line.includes("--no-download")));
});

test("#given the Azure mirror answers #when deps install #then there is no fallback and no wait", (t) => {
	const env = setup(0);
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));
	const result = env.run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(env.read("sleeps"), []);
	assert.equal(env.read("updates")[0], "1");
	assert.match(readFileSync(join(env.etc, "apt-mirrors.txt"), "utf8"), /azure\.archive\.ubuntu\.com/);
});

test("#given every attempt runs to its full 150 s limit #when deps install #then the retries stop inside the 12-minute step and the script reports its own error", (t) => {
	const env = setup(99, 150);
	t.after(() => rmSync(env.dir, { recursive: true, force: true }));
	const result = env.run();
	assert.equal(result.status, 100);
	assert.deepEqual(env.read("sleeps"), ["30", "60"]);
	assert.ok(Number(env.read("clock")[0]) - 1000 < 720, `ended at ${env.read("clock")[0]}`);
	assert.match(result.stdout, /not enough time left in the step/);
	assert.match(result.stdout, /::error::APT transfer failed after retries/);
});
