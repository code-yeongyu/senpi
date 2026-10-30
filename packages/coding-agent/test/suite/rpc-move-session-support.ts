/**
 * Shared rigs for the `move_session` suites: two in-process hosts as two devices (each its own agent directory) and two
 * git checkouts of one repository as the user's working copies.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE } from "../../src/core/repository-identity.ts";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import type { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

export type Rig = ReturnType<typeof createInProcessRig>;
export type MoveFields = Record<string, unknown> & { readonly op: string };

export async function devices() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-rpc-move-")));
	dirs.push(base);
	const repoA = join(base, "a", "repo");
	mkdirSync(repoA, { recursive: true });
	git(repoA, "init", "-q");
	git(repoA, "commit", "-q", "--allow-empty", "-m", "root");
	const repoB = join(base, "b", "repo");
	git(base, "clone", "-q", repoA, repoB);
	const root = git(repoA, "rev-list", "--max-parents=0", "HEAD");
	const agentA = join(base, "agent-a");
	const agentB = join(base, "agent-b");
	const sessionPath = join(getDefaultSessionDir(repoA, agentA), `2026-10-19T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-19T00:00:00.000Z", cwd: repoA },
		{
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-10-19T00:00:00.500Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: { rootCommits: [root] },
		},
		{
			type: "message",
			id: "u1",
			parentId: "r1",
			timestamp: "2026-10-19T00:00:01.000Z",
			message: { role: "user", content: "remember 42", timestamp: 1 },
		},
	];
	writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return { base, repoA, repoB, agentA, agentB, sessionPath };
}

export async function move(rig: Rig, fields: MoveFields): Promise<Record<string, unknown>> {
	const response = await rig.router.handle({ type: "move_session", id: "mv", ...fields } as RpcCommand);
	await rig.settle();
	if (response === undefined) throw new Error("move_session answered nothing");
	return { ...response };
}

export async function hostAndRelease(rig: Rig, cwd: string, sessionPath: string, moveId: string) {
	const session = opened(await rig.open("conn-a", { cwd, sessionPath, retain_on_disconnect: true }), 0);
	await rig.drop("conn-a");
	const released = await rig.router.handle({
		type: "release_session",
		id: "rel",
		sessionId: session.sessionId,
		reason: "move",
		moveId,
		target: "device-b",
	});
	await rig.settle();
	return { session, released };
}

/** B readies the move and A releases and exports the fixture's session for it; returns the bundle folder. */
export async function exportedForB(
	a: Rig,
	b: Rig,
	fixture: Awaited<ReturnType<typeof devices>>,
	moveId: string,
	droppedUserMessages: readonly string[] = [],
): Promise<string> {
	await move(b, { op: "prepare", moveId });
	await hostAndRelease(a, fixture.repoA, fixture.sessionPath, moveId);
	const exported = await move(a, {
		op: "export",
		sessionPath: fixture.sessionPath,
		moveId,
		target: "device-b",
		droppedUserMessages,
	});
	return (exported.data as { bundle_dir: string }).bundle_dir;
}

/** Moves the fixture's session from A to B under `moveId` and returns B's imported copy. */
export async function importedOnB(
	a: Rig,
	b: Rig,
	fixture: Awaited<ReturnType<typeof devices>>,
	moveId: string,
	droppedUserMessages: readonly string[] = [],
) {
	const bundleDir = await exportedForB(a, b, fixture, moveId, droppedUserMessages);
	const imported = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });
	return (imported.data as { session_path: string }).session_path;
}

export const customTypes = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string })
		.map((entry) => entry.customType)
		.filter((type) => type?.startsWith("session_"));
