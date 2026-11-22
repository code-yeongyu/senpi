import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE, type RepositoryIdentity } from "../../src/core/repository-identity.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

export const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
export const REPO: RepositoryIdentity = { rootCommits: ["d".repeat(40)] };
export const OTHER: RepositoryIdentity = { rootCommits: ["e".repeat(40)] };
export const MOVE = "move-0001" as MoveId;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function root(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-")));
	dirs.push(dir);
	return dir;
}

export function writeSession(cwd: string): string {
	const sessionDir = getDefaultSessionDir(cwd);
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `2026-10-18T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-18T00:00:00.000Z", cwd },
		{
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-10-18T00:00:00.500Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: REPO,
		},
		{
			type: "message",
			id: "u1",
			parentId: "r1",
			timestamp: "2026-10-18T00:00:01.000Z",
			message: { role: "user", content: "remember 42", timestamp: 1 },
		},
	];
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	const goal = join(sessionDir, "extensions", "goal", `${SESSION_ID}.json`);
	mkdirSync(dirname(goal), { recursive: true });
	writeFileSync(goal, '{"goal":"ship"}\n');
	return file;
}

export function customTypes(file: string): string[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; customType?: string })
		.filter((entry) => entry.type === "custom")
		.map((entry) => entry.customType ?? "")
		.filter((customType) => customType.startsWith("session_"));
}

export function admittedInputs(file: string): string[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					customType?: string;
					data?: { input?: { clientMessageId?: string; text?: string }; result?: { outcome?: string } };
				},
		)
		.filter((entry) => entry.customType === "pending_input_transition" && entry.data?.result?.outcome === "admitted")
		.map((entry) => entry.data?.input?.text ?? "");
}

export function appendUserMessage(file: string, text: string): void {
	SessionManager.open(file).appendMessage({ role: "user", content: text, timestamp: 3 });
}

export async function setup(
	identity: RepositoryIdentity = REPO,
	moveId: MoveId = MOVE,
	options: { readonly ready?: boolean } = {},
) {
	const base = root();
	const cwdA = join(base, "a", "repo");
	const cwdB = join(base, "b", "repo");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	const source = writeSession(cwdA);
	const bundleDir = join(base, "bundle");
	await exportSessionForMove({
		sessionFile: source,
		moveId,
		target: "device-b",
		droppedUserMessages: ["queued follow-up"],
		bundleDir,
	});
	const ledger = new MoveLedger(join(base, "ledger-b"));
	if (options.ready !== false) await ledger.prepare(moveId);
	const readIdentity = async (dir: string) => (dir === cwdB ? identity : REPO);
	return { base, cwdA, cwdB, source, bundleDir, ledger, readIdentity };
}
