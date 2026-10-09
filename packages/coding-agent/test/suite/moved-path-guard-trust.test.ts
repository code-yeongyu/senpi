import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../src/core/agent-session-runtime.ts";
import { flushGuardLog, guardLogPath } from "../../src/core/extensions/builtin/moved-path-guard/guard-log.ts";
import { findMovedPath, resolveMovedPath } from "../../src/core/extensions/builtin/moved-path-guard/resolve.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import {
	breadcrumbBody,
	createMovedLayout,
	HOME_ID,
	MOVED_SESSIONS,
	MOVED_WORKTREE,
	type MovedLayout,
	writeBreadcrumb,
	writeHomeMarker,
} from "./moved-path-guard-fixtures.ts";

// code-yeongyu/senpi#2898 review H1: a breadcrumb is trusted only when it points at a real, normalized desktop
// home outside itself that holds the desktop's ownership marker with the breadcrumb's homeId.

async function readGuardLog(): Promise<Array<Record<string, unknown>>> {
	await flushGuardLog();
	const text = await readFile(guardLogPath(), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("moved-path-guard breadcrumb trust (#2898)", () => {
	const layouts: MovedLayout[] = [];

	afterEach(() => {
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	function layout(options: Parameters<typeof createMovedLayout>[0] = {}): MovedLayout {
		const created = createMovedLayout(options);
		layouts.push(created);
		return created;
	}

	it("follows a breadcrumb whose new home carries the desktop marker with the same homeId", () => {
		const moved = layout();

		expect(resolveMovedPath(join(moved.oldWorktree, "a.ts"))).toBe(join(moved.newWorktree, "a.ts"));
	});

	// Sixth review LOW-1 (replaces the fifth review's nlink rule, which let a second hard link turn the guard off): a
	// breadcrumb counts only in a folder this user owns that nobody else can write, so a link planted in a shared folder
	// such as /tmp is ignored while the owner's own breadcrumb keeps working with an extra hard link (backups).
	it.skipIf(process.platform === "win32")("ignores a breadcrumb hard-linked into a shared sticky folder", () => {
		const moved = layout();
		const shared = join(moved.home, "shared");
		mkdirSync(shared);
		chmodSync(shared, 0o1777);
		linkSync(join(moved.oldRoot, "omo-desktop-moved.json"), join(shared, "omo-desktop-moved.json"));

		expect(findMovedPath(join(shared, MOVED_WORKTREE, "a.ts"))).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")("still follows the owner's breadcrumb that has an extra hard link", () => {
		const moved = layout();
		mkdirSync(join(moved.home, "backup"));
		linkSync(join(moved.oldRoot, "omo-desktop-moved.json"), join(moved.home, "backup", "omo-desktop-moved.json"));

		expect(resolveMovedPath(join(moved.oldWorktree, "a.ts"))).toBe(join(moved.newWorktree, "a.ts"));
	});

	it.skipIf(process.platform === "win32")("ignores a breadcrumb in a group-writable folder", () => {
		const moved = layout();
		chmodSync(moved.oldRoot, 0o775);

		expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
	});

	it.each([
		["holds no desktop marker", "missing"],
		["belongs to another desktop home", "other-home"],
	] as const)("ignores a breadcrumb whose movedTo %s", (_label, marker) => {
		const moved = layout({ marker });

		expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
	});

	it("ignores a breadcrumb planted in a repository that points anywhere else", () => {
		const moved = layout();
		const repo = join(moved.home, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeBreadcrumb(repo, { ...breadcrumbBody("/etc/somewhere", ["src"]) });

		expect(findMovedPath(join(repo, "src", "x"))).toBeUndefined();
	});

	it.each([
		["a win32-shaped value on this host", "C:\\x"],
		["a path that climbs with ..", "/a/../../../tmp/zz"],
		["a trailing separator", "/a/b/"],
	])("ignores a movedTo with %s", (_label, movedTo) => {
		const moved = layout();
		writeBreadcrumb(moved.oldRoot, breadcrumbBody(movedTo, [MOVED_WORKTREE]));

		expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
	});

	it("ignores a movedTo equal to or inside the breadcrumb's own folder", () => {
		const moved = layout();
		const inside = join(moved.oldRoot, "nested-home");
		writeHomeMarker(inside);
		writeHomeMarker(moved.oldRoot);

		for (const movedTo of [moved.oldRoot, inside]) {
			writeBreadcrumb(moved.oldRoot, breadcrumbBody(movedTo, [MOVED_SESSIONS]));
			expect(findMovedPath(join(moved.oldSessions, "s.jsonl"))).toBeUndefined();
		}
	});

	// Re-review M1/M2: on POSIX a breadcrumb and a marker count only when they are this user's own regular files,
	// not writable by group or others, and small.
	describe.runIf(process.platform !== "win32")("file ownership and size", () => {
		it("follows a 0600 breadcrumb and marker", () => {
			const moved = layout();
			chmodSync(join(moved.oldRoot, "omo-desktop-moved.json"), 0o600);
			chmodSync(join(moved.newRoot, "omo-desktop-home.json"), 0o600);

			expect(findMovedPath(join(moved.oldWorktree, "a.ts"))?.mappedPath).toBe(join(moved.newWorktree, "a.ts"));
		});

		it.each([
			["a world-writable breadcrumb", "breadcrumb", 0o666],
			["a group-writable breadcrumb", "breadcrumb", 0o620],
			["a world-writable marker", "marker", 0o666],
		] as const)("ignores %s, even in a world-writable folder", (_label, which, mode) => {
			const moved = layout();
			chmodSync(moved.oldRoot, 0o777);
			const file =
				which === "breadcrumb"
					? join(moved.oldRoot, "omo-desktop-moved.json")
					: join(moved.newRoot, "omo-desktop-home.json");
			chmodSync(file, mode);

			expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
		});

		it("ignores a breadcrumb that is a symlink to a real one", () => {
			const moved = layout();
			const real = join(moved.home, "real-breadcrumb.json");
			renameSync(join(moved.oldRoot, "omo-desktop-moved.json"), real);
			symlinkSync(real, join(moved.oldRoot, "omo-desktop-moved.json"));

			expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
		});

		it("ignores an oversized breadcrumb without parsing it", () => {
			const moved = layout();
			const body = { ...breadcrumbBody(moved.newRoot, [MOVED_WORKTREE]), padding: "x".repeat(70 * 1024) };
			writeBreadcrumb(moved.oldRoot, body);

			expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
		});
	});

	// Fourth review M-c: the desktop may write movedTo realpath'd while HOME is a symlink (or /tmp vs /private/tmp);
	// that home is still the user's.
	it.runIf(process.platform !== "win32")(
		"follows a breadcrumb whose movedTo is the realpath of a symlinked home",
		() => {
			const moved = layout();
			const alias = `${moved.home}-alias`;
			symlinkSync(moved.home, alias);
			const saved = process.env.HOME;
			process.env.HOME = alias;
			try {
				expect(findMovedPath(join(alias, ".t3", MOVED_WORKTREE, "a.ts"))?.mappedPath).toBe(
					join(moved.newWorktree, "a.ts"),
				);
			} finally {
				process.env.HOME = saved;
				rmSync(alias, { force: true });
			}
		},
	);

	// Re-review L6: a marker from a newer desktop is untrusted, and that is logged at warn level, not silent.
	it("ignores a newer marker schema and logs it at warn level", async () => {
		const moved = layout();
		writeFileSync(
			join(moved.newRoot, "omo-desktop-home.json"),
			JSON.stringify({ kind: "omo-desktop-data-home", appId: "com.omo.desktop", schemaVersion: 2, homeId: HOME_ID }),
		);

		expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
		const entries = await readGuardLog();
		expect(entries).toContainEqual(
			expect.objectContaining({
				level: "warn",
				event: "marker_newer",
				file: join(moved.newRoot, "omo-desktop-home.json"),
			}),
		);
	});

	// Review L5: an ignored breadcrumb is recorded in the debug log, never printed into the terminal a TUI owns.
	it("reports an ignored breadcrumb without writing to the terminal", () => {
		const moved = layout({ schemaVersion: 2 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(findMovedPath(join(moved.oldWorktree, "a.ts"))).toBeUndefined();
			expect(warn).not.toHaveBeenCalled();
			expect(stderr).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			stderr.mockRestore();
		}
	});

	it("never hands open_session a relative path from an untrusted breadcrumb", async () => {
		const moved = layout();
		writeBreadcrumb(moved.oldRoot, breadcrumbBody("C:\\x", [MOVED_WORKTREE]));
		const cwds: string[] = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			cwds.push(options.cwd);
			return {
				session: {
					sessionManager: options.sessionManager,
					agentDir: options.agentDir,
					extensionRunner: { hasHandlers: () => false, emit: async () => {} },
					abort: async () => {},
					abortBash: () => {},
					waitForIdle: async () => {},
					dispose: () => {},
				},
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		};
		mkdirSync(moved.oldWorktree, { recursive: true });
		const registry = new RpcSessionRegistry({ agentDir: moved.home, createRuntime });

		const opened = await registry.openSession({ cwd: moved.oldWorktree });

		expect(cwds.every((cwd) => isAbsolute(cwd))).toBe(true);
		await registry.close(opened.sessionId);
	});
});
