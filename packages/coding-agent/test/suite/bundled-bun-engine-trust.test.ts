/**
 * Security contract (omo#10762, design r13 5.6): the bundled `bun`/`bunx` shim of an engine that
 * adopted a trust generation sets that generation and the owned default-input closure only for its
 * own exec, clears Bun's system-store switches for a server launch, and prints the degraded-import
 * notice once per fallback generation. A shim the writer cannot encode fails instead of running
 * the engine's own entrypoint without its trust.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineTrustAction } from "../../src/engine-trust/index.ts";
import { type BundledBunHost, bundledBunDir } from "../../src/utils/bundled-bun.ts";
import { serverMarker, standaloneMarker } from "./engine-trust-fixtures.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function host(overrides: Partial<BundledBunHost> = {}): BundledBunHost {
	const root = mkdtempSync(join(tmpdir(), "senpi-shim-"));
	roots.push(root);
	return {
		main: "/$bunfs/root/omo",
		execPath: "/opt/omo/bin/omo",
		platform: "linux",
		shimRoots: [root],
		...overrides,
	};
}

function shim(h: BundledBunHost, name: string): string {
	const dir = bundledBunDir(h);
	if (dir === undefined) throw new Error("no shim directory");
	return readFileSync(join(dir, name), "utf8");
}

describe("bundled bun shim without an adopted generation", () => {
	it("keeps today's shim bytes", () => {
		expect(shim(host(), "bun")).toBe("#!/bin/sh\nBUN_BE_BUN=1 exec '/opt/omo/bin/omo' \"$@\"\n");
	});
});

describe("bundled bun shim of an adopted generation (POSIX)", () => {
	it("sets the generation and the closure for its own exec and clears the system switches for a server launch", () => {
		const { defaults } = serverMarker;
		expect(shim(host({ trust: serverMarker }), "bun")).toBe(
			[
				"#!/bin/sh",
				"unset NODE_USE_SYSTEM_CA BUN_OPTIONS",
				`BUN_BE_BUN=1 NODE_EXTRA_CA_CERTS='${serverMarker.file}' SSL_CERT_FILE='${defaults?.file}' SSL_CERT_DIR='${defaults?.dir}' exec '/opt/omo/bin/omo' "$@"`,
				"",
			].join("\n"),
		);
	});

	it("leaves a standalone user's own SSL values and system switches under an explicit opt-in", () => {
		const optIn = { ...serverMarker, owner: "standalone" as const, defaults: null, restore: {} };
		expect(shim(host({ trust: optIn }), "bunx")).toBe(
			`#!/bin/sh\nBUN_BE_BUN=1 NODE_EXTRA_CA_CERTS='${serverMarker.file}' exec '/opt/omo/bin/omo' x "$@"\n`,
		);
	});

	it("keeps one directory per generation", () => {
		const base = host();
		const first = bundledBunDir({ ...base, trust: serverMarker });
		const second = bundledBunDir({ ...base, trust: { ...serverMarker, file: "/home/u/.omo/engine-trust/bbbb.pem" } });
		const none = bundledBunDir(base);
		expect(new Set([first, second, none]).size).toBe(3);
	});

	// Paths holding a quote and a newline: POSIX single quotes must carry every byte.
	const hostile = (h: BundledBunHost) => {
		const base = join(h.shimRoots[0] ?? "", "it's\nhere");
		mkdirSync(base);
		const fake = join(base, "fake-engine.sh");
		writeFileSync(
			fake,
			'#!/bin/sh\nset_or_unset() { if [ -n "$1" ]; then printf set; else printf unset; fi; }\nprintf "%s|%s|%s|%s|%s|%s\\n" "$BUN_BE_BUN" "$NODE_EXTRA_CA_CERTS" "$(set_or_unset "$NODE_USE_SYSTEM_CA")" "$(set_or_unset "$BUN_OPTIONS")" "$SSL_CERT_DIR" "$*"\n',
		);
		chmodSync(fake, 0o755);
		const trust = {
			...serverMarker,
			automatic: "fallback" as const,
			fallbackReason: "helper-timeout" as const,
			file: join(base, "gen'$(x)`y`.pem"),
		};
		return { fake, trust };
	};
	const ambient = { PATH: "/usr/bin:/bin", NODE_USE_SYSTEM_CA: "1", BUN_OPTIONS: "--use-system-ca" };

	it("runs the engine with the generation through hostile paths, clears both switches, and notices a fallback once", () => {
		const h = host();
		const { fake, trust } = hostile(h);
		const dir = bundledBunDir({ ...h, execPath: fake, trust });
		if (dir === undefined) throw new Error("no shim directory");
		const runs = [1, 2].map(() => spawnSync(join(dir, "bun"), ["test", "a b"], { env: ambient, encoding: "utf8" }));
		expect(runs.map((run) => run.status)).toEqual([0, 0]);
		expect(runs[0]?.stdout).toBe(`1|${trust.file}|unset|unset|${serverMarker.defaults?.dir}|test a b\n`);
		expect(runs[0]?.stderr).toContain("(helper-timeout)");
		expect(runs[0]?.stderr).toContain(engineTrustAction("helper-timeout").text);
		expect(runs[1]?.stderr).toBe("");
	});

	it("still runs the engine when the notice sentinel cannot be written (senpi#4529 review)", () => {
		const h = host();
		const { fake, trust } = hostile(h);
		const dir = bundledBunDir({ ...h, execPath: fake, trust });
		if (dir === undefined) throw new Error("no shim directory");
		chmodSync(dir, 0o555);
		try {
			const run = spawnSync(join(dir, "bun"), ["x"], { env: ambient, encoding: "utf8" });
			expect(run.status).toBe(0);
			expect(run.stdout).toBe(`1|${trust.file}|unset|unset|${serverMarker.defaults?.dir}|x\n`);
		} finally {
			chmodSync(dir, 0o755);
		}
	});
});

describe("bundled bun shim of an adopted generation (Windows .cmd)", () => {
	it("localizes its variables, doubles %, and clears the system switches for a server launch", () => {
		const trust = {
			...serverMarker,
			file: "C:\\Users\\u\\100%\\aaaa.pem",
			defaults: { file: "C:\\t\\empty.pem", dir: "C:\\t\\empty.d" },
		};
		expect(shim(host({ platform: "win32", execPath: "C:\\omo\\omo.exe", trust }), "bun.cmd")).toBe(
			[
				"@echo off",
				"setlocal",
				'set "NODE_USE_SYSTEM_CA="',
				'set "BUN_OPTIONS="',
				'set "BUN_BE_BUN=1"',
				'set "NODE_EXTRA_CA_CERTS=C:\\Users\\u\\100%%\\aaaa.pem"',
				'set "SSL_CERT_FILE=C:\\t\\empty.pem"',
				'set "SSL_CERT_DIR=C:\\t\\empty.d"',
				'"C:\\omo\\omo.exe" %*',
				"exit /b %ERRORLEVEL%",
				"",
			].join("\r\n"),
		);
	});

	it("escapes the fallback notice for a parenthesized block", () => {
		const trust = { ...standaloneMarker, fallbackReason: "helper-missing" as const };
		const text = shim(host({ platform: "win32", execPath: "C:\\omo\\omo.exe", trust }), "bun.cmd");
		const notice = text.split("\r\n").find((line) => line.startsWith("if not exist"));
		expect(notice).toContain("^(helper-missing^)");
		expect(notice).toContain("^(omo update; desktop: install the current app^)");
		const body = notice?.slice(notice.indexOf(" echo ") + 6, notice.indexOf("& type nul")) ?? "";
		expect(body.replace(/\^[()&|<>^]/gu, "")).not.toMatch(/[()&|<>^]/u);
	});

	it("fails with the set-tmpdir action instead of running the engine when a path cannot be encoded", () => {
		const trust = { ...serverMarker, file: 'C:\\bad"name.pem' };
		const text = shim(host({ platform: "win32", execPath: "C:\\omo\\omo.exe", trust }), "bun.cmd");
		expect(text).not.toContain("omo.exe");
		expect(text).toContain("trust-path-unrepresentable");
		expect(text).toContain("exit /b 78");
	});
});
