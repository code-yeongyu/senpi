import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type LockSite,
	lockSiteProblems,
	referenceViolations,
	vendoredSelfContainedViolations,
} from "./support/lock-site-scan.ts";

// Source gates for proper-lockfile (oh-my-openagent#10878):
// 1. Only core/file-lock.ts may reference the package: an async lock elsewhere gets the default
//    onCompromised, which throws from a heartbeat timer. The listed lockSync-only files (no
//    heartbeat) may use their default import only for the sync calls, and the listed vendored
//    self-contained files only for `.lock(` calls that pass their own onCompromised.
// 2. A holder that lost a live lock must stop. Each lockWithLossHandling( call passes onLost, or
//    its call site is listed below with a reason, and each write under that lock has its own
//    assertHeld() right before it.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SRC = "packages/coding-agent/src";
const HELPER = `${SRC}/core/file-lock.ts`;

const LOCK_SYNC_ONLY = new Set(
	[
		"core/auth-storage.ts",
		"core/settings-manager.ts",
		"core/trust-manager.ts",
		"core/extensions/builtin/hooks/trust-storage.ts",
		"package-manager-cli.ts",
	].map((path) => `${SRC}/${path}`),
);

// Files vendored byte-for-byte into another repository (oh-my-openagent) may not import senpi internals, so they
// cannot use core/file-lock.ts. Each must give every proper-lockfile lock call its own onCompromised (the default throws
// from a heartbeat timer) and refuse the write before each commit rename once the lock was lost; tested in
// test/file-lock-lost-writes.test.ts and test/suite/regressions/3796-grants-store.test.ts.
const VENDORED_SELF_CONTAINED = new Set(
	["core/extensions/builtin/mcp/env-grants-store.ts"].map((path) => `${SRC}/${path}`),
);

const at = (file: string) => `${SRC}/${file}`;
const LOCK_SITES: Record<string, LockSite> = {
	[`${at("core/extensions/builtin/mcp/catalog-cache.ts")}#writeMcpCachedServer`]: {
		reason: "best-effort cache: the atomic rename is skipped once the lock is lost",
		writes: [{ file: at("core/extensions/builtin/mcp/catalog-cache.ts"), fn: "atomicWriteJson", op: "rename(tmp" }],
	},
	[`${at("core/credential-pool/state-file.ts")}#lockFileBefore`]: {
		reason: "one short read-modify-write of the pool health sidecar",
		writes: [{ file: at("core/credential-pool/state-store.ts"), fn: "withDocument", op: "writeStateFileAtomic(" }],
	},
	[`${at("core/extensions/builtin/mcp/auth/token-store.ts")}##acquire`]: {
		reason: "update, clear and withLock (the OAuth refresh) write only through these methods",
		writes: [
			{ file: at("core/extensions/builtin/mcp/auth/token-store.ts"), fn: "#writeAtomic", op: "renameSync(tmp" },
			{
				file: at("core/extensions/builtin/mcp/auth/token-store.ts"),
				fn: "#removeRecord",
				op: "this.#removeTokens(",
			},
			{ file: at("core/extensions/builtin/mcp/auth/token-store.ts"), fn: "#writeIndex", op: "writeIndexEntry(" },
			{ file: at("core/extensions/builtin/mcp/auth/token-store.ts"), fn: "clear", op: "rmSync(this.dir" },
		],
	},
	[`${at("core/session-move/move-ledger-lock.ts")}#acquireMoveRecordLock`]: {
		reason: "every record write goes through MoveLedger.write",
		writes: [{ file: at("core/session-move/move-ledger.ts"), fn: "write", op: "renameFile(temp" }],
	},
	[`${at("core/settings-manager.ts")}#acquireLockWithRetry`]: {
		reason: "the async settings publish is one rename",
		writes: [{ file: at("core/settings-manager.ts"), fn: "withPathLockAsync", op: "rename(tempPath" }],
	},
	[`${at("experimental/server.ts")}#acquireServerProfile`]: {
		reason: "server startup aborts before it goes live",
		writes: [{ file: at("experimental/server.ts"), fn: "startServer", op: "relay.start(" }],
	},
	[`${at("experimental/server.ts")}#acquireServerActivation`]: {
		reason: "activation aborts before spawning and before handing back a foreground server",
		writes: [
			{ file: at("experimental/server.ts"), fn: "activateServer", op: "spawnInternalProcess(" },
			{ file: at("experimental/server.ts"), fn: "startForegroundServer", op: "return server;" },
		],
	},
	[`${at("package-manager-cli.ts")}#runManagedSelfUpdate`]: {
		reason: "the update aborts before its release rename and before each activation",
		writes: [
			{ file: at("package-manager-cli.ts"), fn: "runManagedSelfUpdate", op: "renameSync(stageDir" },
			{ file: at("package-manager-cli.ts"), fn: "runManagedSelfUpdate", op: "activateManagedRelease(" },
		],
	},
};

const SOURCE_EXTENSION = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

function sourceFiles(directory: string, insideSrc: boolean): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path, insideSrc || entry.name === "src"));
		} else if (insideSrc && SOURCE_EXTENSION.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

const repoSources = (): Map<string, string> =>
	new Map(
		sourceFiles(join(repoRoot, "packages"), false).map((path) => [
			relative(repoRoot, path).split(sep).join("/"),
			readFileSync(path, "utf8"),
		]),
	);

describe("proper-lockfile reference guard", () => {
	it("rejects every way to reach the async lock outside the helper", () => {
		for (const shape of [
			'import lockfile from "proper-lockfile";',
			'import * as pl from "proper-lockfile";',
			'import lockfile, { lock } from "proper-lockfile";',
			'import type { LockOptions } from "proper-lockfile";',
			'const pl = require("proper-lockfile");',
			'const { lock } = require("proper-lockfile");',
			'const pl = createRequire(import.meta.url)("proper-lockfile");',
			'const pl = await import("proper-lockfile");',
			'const url = "https://x"; const pl = require("proper-lockfile");',
		]) {
			expect(referenceViolations(shape, false), shape).not.toEqual([]);
		}
		expect(referenceViolations("// see proper-lockfile\n/* proper-lockfile */ const a = 1;", false)).toEqual([]);
	});

	it("allows a lockSync-only file only the sync calls on its default import", () => {
		const head = 'import lockfile from "proper-lockfile";\nimport { x } from "./lockfile-policy.ts";\n';
		expect(referenceViolations(`${head}lockfile.lockSync(p);\nlockfile.unlockSync(p);`, true)).toEqual([]);
		for (const body of [
			"await lockfile.lock(p);",
			'await lockfile["lock"](p);',
			"const { lock } = lockfile;",
			"const alias = lockfile;",
			"run(lockfile);",
			'const pl = require("proper-lockfile");',
		]) {
			expect(referenceViolations(`${head}${body}`, true), body).not.toEqual([]);
		}
		expect(referenceViolations('import lockfile, { lock } from "proper-lockfile";', true)).not.toEqual([]);
	});

	describe("lock call sites are checked per call", () => {
		const file = "src/store.ts";
		const sites: Record<string, LockSite> = {
			[`${file}#save`]: { reason: "test", writes: [{ file, fn: "commit", op: "renameSync(" }] },
		};
		const listed = [
			"export async function save(path: string): Promise<void> {",
			"\tconst lock = await lockWithLossHandling(path, { realpath: false });",
			"\tcommit(lock);",
			"}",
			"function commit(lock: HeldFileLock): void {",
			"\tlock.assertHeld();",
			"\trenameSync(a, b);",
			"}",
			"",
		].join("\n");

		it("accepts a listed call whose write has its own assertHeld()", () => {
			expect(lockSiteProblems(new Map([[file, listed]]), sites)).toEqual([]);
		});

		it("RED: a new lock call without onLost in an already-allowlisted file fails", () => {
			const added = `${listed}export async function other(path: string): Promise<void> {\n\tawait lockWithLossHandling(path, {});\n}\n`;
			expect(lockSiteProblems(new Map([[file, added]]), sites)).toEqual([
				`${file}#other: lock call without onLost is not an allowlisted site`,
			]);
		});

		it("RED: a second unlisted lock call inside an allowlisted function fails", () => {
			const doubled = listed.replace("\tcommit(lock);", "\tcommit(lock);\n\tawait lockWithLossHandling(path, {});");
			expect(lockSiteProblems(new Map([[file, doubled]]), sites)).toEqual([
				`${file}#save: 2 lock calls without onLost share one allowlisted site`,
			]);
		});

		it("RED: a locked write without its own assertHeld() fails, even with one earlier in the function", () => {
			const shared = listed.replace("\trenameSync(a, b);", "\trenameSync(a, b);\n\trenameSync(c, d);");
			expect(lockSiteProblems(new Map([[file, shared]]), sites)).toEqual([
				`${file}#save -> ${file}#commit renameSync(: write without its own assertHeld() before it`,
			]);
			const missing = listed.replace("\tlock.assertHeld();\n", "");
			expect(lockSiteProblems(new Map([[file, missing]]), sites)).toHaveLength(1);
		});

		it("a call that passes onLost needs no allowlist entry; a stale entry fails", () => {
			const withOnLost = listed.replace("{ realpath: false }", "{ realpath: false, onLost: stop }");
			expect(lockSiteProblems(new Map([[file, withOnLost]]), {})).toEqual([]);
			expect(lockSiteProblems(new Map([[file, withOnLost]]), sites)).toEqual([
				`${file}#save: allowlisted site has no lock call without onLost`,
			]);
		});
	});

	it("no file under packages/*/src references proper-lockfile except the helper, the lockSync-only files and the vendored self-contained files", () => {
		const offenders = [...repoSources()]
			.filter(([path]) => path !== HELPER && !VENDORED_SELF_CONTAINED.has(path))
			.map(([path, source]) => ({ path, problems: referenceViolations(source, LOCK_SYNC_ONLY.has(path)) }))
			.filter(({ problems }) => problems.length > 0);
		expect(offenders).toEqual([]);
	});

	describe("vendored self-contained files", () => {
		const valid = [
			'import { rename } from "node:fs/promises";',
			'import lockfile from "proper-lockfile";',
			"export async function save(path: string): Promise<void> {",
			"\tconst release = await lockfile.lock(path, { realpath: false, onCompromised: () => {} });",
			"\tawait rename(path, path);",
			"\tawait release();",
			"}",
			"",
		].join("\n");

		it("accepts node built-ins plus one default import used only for .lock( calls with their own onCompromised", () => {
			expect(vendoredSelfContainedViolations(valid)).toEqual([]);
		});

		it("RED: a destructured lock that keeps the default onCompromised fails", () => {
			const destructured = `${valid}const { lock } = lockfile;\nexport const again = (path: string) => lock(path);\n`;
			expect(vendoredSelfContainedViolations(destructured)).toEqual([
				"uses lockfile other than as lockfile.lock(: lockfile",
			]);
		});

		it("RED: a side-effect import of a senpi module fails", () => {
			expect(vendoredSelfContainedViolations(`import "../../../file-lock.ts";\n${valid}`)).toEqual([
				"imports ../../../file-lock.ts",
			]);
		});

		it("RED: a workspace package import fails", () => {
			expect(
				vendoredSelfContainedViolations(`import { brand } from "@earendil-works/pi-telemetry";\n${valid}`),
			).toEqual(["imports @earendil-works/pi-telemetry"]);
		});

		it("RED: a second lock call without its own onCompromised fails even when another call has one", () => {
			const second = `${valid}export const other = (path: string) => lockfile.lock(path, { realpath: false });\n`;
			expect(vendoredSelfContainedViolations(second)).toEqual(["lockfile.lock( without its own onCompromised"]);
		});

		// #4035: every import form keeps its own row, so weakening one branch fails here.
		it.each([
			[
				"a require of a senpi file",
				'const x = require("../../../file-lock.ts");',
				["imports ../../../file-lock.ts"],
			],
			["a re-export", 'export { lock } from "../../../file-lock.ts";', ["imports ../../../file-lock.ts"]],
			["a literal dynamic import", 'await import("../../../file-lock.ts");', ["imports ../../../file-lock.ts"]],
			["a computed dynamic import", "await import(name);", ["dynamic import or require of a computed module"]],
		])("rejects %s", (_name, extra, expected) => {
			expect(vendoredSelfContainedViolations(`${extra}\n${valid}`)).toEqual(expected);
		});

		// #4035: ways around the scanner that it missed before.
		it.each([
			[
				"a template import whose substitution holds a quote",
				// oxlint-disable-next-line eslint/no-template-curly-in-string -- scanner input: the source text of a template import.
				'await import(`${"../../../file-lock.ts"}`);',
				["dynamic import or require of a computed module"],
			],
			[
				"createRequire from node:module",
				'import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("../x.ts");',
				["imports node:module", "loads modules through createRequire"],
			],
			[
				"process.getBuiltinModule without an import",
				'process.getBuiltinModule("node:module");',
				["loads modules through getBuiltinModule"],
			],
		])("RED: %s fails", (_name, extra, expected) => {
			expect(vendoredSelfContainedViolations(`${extra}\n${valid}`)).toEqual(expected);
		});

		it.each([
			["onCompromised: undefined", "onCompromised: undefined", "lockfile.lock( without its own onCompromised"],
			["onCompromised: null", "onCompromised: null", "lockfile.lock( without its own onCompromised"],
			[
				"a spread after onCompromised",
				"onCompromised: () => {}, ...options",
				"lockfile.lock( spreads options that can replace onCompromised",
			],
		])("RED: a lock call with %s fails", (_name, options, expected) => {
			const call = `export const other = (path: string, options: object) => lockfile.lock(path, { ${options} });\n`;
			expect(vendoredSelfContainedViolations(`${valid}${call}`)).toEqual([expected]);
		});

		it("RED: a parenthesis inside a string does not end the lock arguments early", () => {
			const call =
				'export const other = (path: string) => lockfile.lock(path, { tag: ")", onCompromised: () => {} });\n';
			expect(vendoredSelfContainedViolations(`${valid}${call}`)).toEqual([]);
		});

		it("RED: a /* inside a regular expression does not hide the code after it", () => {
			const hidden = 'const pattern = /a/*x/;\nimport("../../../file-lock.ts");\nconst end = 1; // */\n';
			expect(vendoredSelfContainedViolations(`${hidden}${valid}`)).toEqual(["imports ../../../file-lock.ts"]);
		});

		// #4035 review: a division after a postfix ++/-- or a closing bracket is not a regex, so nothing after it is hidden.
		it.each(["x++ / y", "x-- / y", "(x) / y", "x[0] / y", "x / y"])(
			"RED: code after a division %s with a later // stays visible",
			(division) => {
				const hidden = `const q = ${division}; const s = "a/b//c"; import("../../../file-lock.ts");\n`;
				expect(vendoredSelfContainedViolations(`${hidden}${valid}`)).toEqual(["imports ../../../file-lock.ts"]);
			},
		);

		it("accepts a spread before onCompromised and a handler whose text contains ...", () => {
			const calls = [
				"export const a = (path: string, options: object) => lockfile.lock(path, { ...options, onCompromised: () => {} });",
				'export const b = (path: string) => lockfile.lock(path, { onCompromised: () => console.warn("lock lost...") });',
				"",
			].join("\n");
			expect(vendoredSelfContainedViolations(`${valid}${calls}`)).toEqual([]);
		});

		it("every listed vendored file passes", () => {
			const sources = repoSources();
			for (const path of VENDORED_SELF_CONTAINED) {
				const source = sources.get(path);
				expect(source, path).toBeDefined();
				expect(vendoredSelfContainedViolations(source ?? ""), path).toEqual([]);
			}
		});
	});

	it("every lock call passes onLost or is an allowlisted call site whose writes each assert the lock", () => {
		const sources = repoSources();
		sources.delete(HELPER);
		expect(lockSiteProblems(sources, LOCK_SITES)).toEqual([]);
	});
});
