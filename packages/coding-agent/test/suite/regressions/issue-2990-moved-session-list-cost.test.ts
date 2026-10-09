import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMovedPath } from "../../../src/core/extensions/builtin/moved-path-guard/resolve.ts";
import { findMostRecentSession, SessionManager } from "../../../src/core/session-manager.ts";
import { createMovedLayout, type MovedLayout, writeSessionHeader } from "../moved-path-guard-fixtures.ts";

// The resolver stays real; the mock only counts how often listing asks it.
vi.mock("../../../src/core/extensions/builtin/moved-path-guard/resolve.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/core/extensions/builtin/moved-path-guard/resolve.ts")>();
	return { ...actual, resolveMovedPath: vi.fn(actual.resolveMovedPath) };
});

/**
 * code-yeongyu/senpi#2990 review H1: matching a listed session's recorded cwd through the moved-path resolver runs a
 * synchronous filesystem walk. `SessionManager.list` re-filters the growing list on every progress tick, so the walk
 * must run at most once per distinct recorded cwd per call, or the `--resume` and `/resume` pickers turn quadratic on
 * a shared session dir.
 */

const SESSIONS = 60;
const OTHER_PROJECTS = 4;
const resolver = vi.mocked(resolveMovedPath);

let layout: MovedLayout;
beforeEach(() => {
	layout = createMovedLayout();
	for (let project = 0; project < OTHER_PROJECTS; project++)
		mkdirSync(join(layout.home, "projects", String(project)), { recursive: true });
	for (let index = 0; index < SESSIONS; index++) {
		const id = `0199f0d4-2990-7000-8000-${String(index).padStart(12, "0")}`;
		const cwd = join(layout.home, "projects", String(index % OTHER_PROJECTS));
		writeSessionHeader(join(layout.newSessions, `${id}.jsonl`), id, cwd);
	}
	const movedFile = join(layout.newSessions, "moved.jsonl");
	writeSessionHeader(movedFile, "0199f0d4-2990-7000-8000-0000000000ff", layout.oldWorktree);
	// Oldest, so finding the newest match scans every other session first.
	utimesSync(movedFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
	resolver.mockClear();
});
afterEach(() => layout.cleanup());

describe("issue #2990 listing a shared session dir resolves each recorded cwd once", () => {
	it("list() with progress, as both pickers call it", async () => {
		const ticks: number[] = [];

		const sessions = await SessionManager.list(layout.newWorktree, layout.newSessions, (loaded) =>
			ticks.push(loaded),
		);

		expect(sessions.map((session) => session.path)).toEqual([join(layout.newSessions, "moved.jsonl")]);
		expect(ticks).toHaveLength(SESSIONS + 1);
		expect(resolver.mock.calls.length).toBeLessThanOrEqual(OTHER_PROJECTS + 1);
	});

	it("findMostRecentSession() and findById() with a session dir", () => {
		expect(findMostRecentSession(layout.newSessions, layout.newWorktree)).toBe(
			join(layout.newSessions, "moved.jsonl"),
		);
		expect(resolver.mock.calls.length).toBeLessThanOrEqual(OTHER_PROJECTS + 1);
		resolver.mockClear();

		expect(
			SessionManager.findById(layout.newWorktree, "0199f0d4-2990-7000-8000-0000000000ff", layout.newSessions),
		).toBe(join(layout.newSessions, "moved.jsonl"));
		expect(resolver.mock.calls.length).toBeLessThanOrEqual(1);
	});
});
