import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecuteToolError } from "../../src/core/extensions/types.ts";
import type { Harness } from "./harness.ts";

/**
 * A desktop data-home move as the OmO desktop leaves it (code-yeongyu/senpi#2898): the old root keeps only
 * `omo-desktop-moved.json`, and the moved worktree and session dirs live under the new root.
 */
export interface MovedLayout {
	/** A stand-in `$HOME`, realpath'd so macOS `/var` -> `/private/var` never splits one path into two spellings. */
	readonly home: string;
	/** The old data root that holds the breadcrumb (`~/.t3`). */
	readonly oldRoot: string;
	/** The new data root the breadcrumb points at (`~/.omo/desktop`). */
	readonly newRoot: string;
	readonly oldWorktree: string;
	readonly newWorktree: string;
	readonly oldSessions: string;
	readonly newSessions: string;
	cleanup(): void;
}

export const MOVED_WORKTREE = "worktrees/app/w1";
export const MOVED_SESSIONS = "userdata/omo-sessions";

export function writeBreadcrumb(oldRoot: string, body: Record<string, unknown>): void {
	mkdirSync(oldRoot, { recursive: true });
	writeFileSync(join(oldRoot, "omo-desktop-moved.json"), `${JSON.stringify(body, null, 2)}\n`);
}

export const HOME_ID = "0199f0d4-0000-7000-8000-000000000000";

export function breadcrumbBody(newRoot: string, moved: readonly string[], schemaVersion = 1): Record<string, unknown> {
	return {
		kind: "omo-desktop-moved",
		schemaVersion,
		movedTo: newRoot,
		homeId: HOME_ID,
		movedAt: "2026-10-07T00:00:00.000Z",
		byVersion: "0.0.0-test",
		moved,
	};
}

/** The desktop's ownership marker (plan section 2) that binds a breadcrumb to a real home. */
export function writeHomeMarker(home: string, homeId: string = HOME_ID): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(home, "omo-desktop-home.json"),
		`${JSON.stringify({
			kind: "omo-desktop-data-home",
			appId: "com.omo.desktop",
			schemaVersion: 1,
			homeId,
			createdAt: "2026-10-07T00:00:00.000Z",
			createdByVersion: "0.0.0-test",
			createdBy: "desktop",
			placement: "final",
			origin: { type: "moved", from: "/elsewhere", method: "rename", ledgerMaxId: 69, proof: "ledger" },
		})}\n`,
	);
}

/**
 * Builds the post-move layout. `breadcrumb: false` leaves the old root with no breadcrumb at all;
 * `marker` controls the new home's ownership marker (default: one with the breadcrumb's homeId).
 */
export function createMovedLayout(
	options: { breadcrumb?: boolean; schemaVersion?: number; marker?: "valid" | "missing" | "other-home" } = {},
): MovedLayout {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "senpi-moved-home-")));
	// The layout is the user's home for the test: every desktop data home lives under it (plan 1.1).
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	const oldRoot = join(home, ".t3");
	const newRoot = join(home, ".omo", "desktop");
	const newWorktree = join(newRoot, MOVED_WORKTREE);
	const newSessions = join(newRoot, MOVED_SESSIONS);
	mkdirSync(oldRoot, { recursive: true });
	mkdirSync(newWorktree, { recursive: true });
	mkdirSync(newSessions, { recursive: true });
	if (options.marker !== "missing")
		writeHomeMarker(newRoot, options.marker === "other-home" ? "another-home" : HOME_ID);
	if (options.breadcrumb !== false) {
		writeBreadcrumb(oldRoot, breadcrumbBody(newRoot, [MOVED_WORKTREE, MOVED_SESSIONS], options.schemaVersion));
	}
	return {
		home,
		oldRoot,
		newRoot,
		oldWorktree: join(oldRoot, MOVED_WORKTREE),
		newWorktree,
		oldSessions: join(oldRoot, MOVED_SESSIONS),
		newSessions,
		cleanup: () => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** A session file header, so an open of the path is a resume rather than a create. */
export function writeSessionHeader(path: string, id: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

export type ToolOutcome =
	| { readonly outcome: "blocked"; readonly text: string }
	| { readonly outcome: "error" | "ok"; readonly text: string };

/** Runs one top-level tool call the way codemode does and reports whether the guard blocked it before it ran. */
export async function runTool(harness: Harness, name: string, params: Record<string, unknown>): Promise<ToolOutcome> {
	try {
		const result = await harness.session.executeTool(name, params);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const failed = (result.details as { isError?: boolean } | undefined)?.isError === true;
		return { outcome: failed ? "error" : "ok", text };
	} catch (error) {
		if (error instanceof ExecuteToolError && error.code === "blocked")
			return { outcome: "blocked", text: error.message };
		throw error;
	}
}
