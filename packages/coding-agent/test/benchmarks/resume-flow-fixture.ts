import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

export const SELECTED_SESSION_ID = "resume-bench-selected";
export const DECOY_SESSION_COUNT = 8;
export const DECOY_MESSAGE_COUNT = 12;
export const SESSION_TIMESTAMP_BASE = 1_800_000_000_000;

export type ResumeBenchFixture = {
	readonly rootDir: string;
	readonly cwd: string;
	readonly sessionDir: string;
	readonly selectedPath: string;
	readonly selectedId: string;
	readonly fixtureBytes: number;
	readonly decoySessionCount: number;
};

type SessionFileSpec = {
	readonly path: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly messageCount: number;
};

function usage() {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userText(index: number, sessionId: string): string {
	return `user ${sessionId} turn ${index} resume-load-probe`;
}

function assistantText(index: number, sessionId: string): string {
	return [
		`### Result ${index}`,
		"",
		`assistant ${sessionId} turn ${index} with **bold** and a list:`,
		"",
		`- item ${index}`,
		`- item ${index + 1}`,
		"",
		"```ts",
		`const value = ${index};`,
		"console.log(value);",
		"```",
	].join("\n");
}

function entryId(index: number): string {
	return `e${String(index).padStart(6, "0")}`;
}

function sessionEntryLine(spec: SessionFileSpec, index: number, parentId: string | null): string {
	const id = entryId(index);
	const timestamp = new Date(SESSION_TIMESTAMP_BASE + index).toISOString();
	if (index % 2 === 0) {
		return `${JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp,
			message: {
				role: "user",
				content: [{ type: "text", text: userText(index, spec.sessionId) }],
				timestamp: SESSION_TIMESTAMP_BASE + index,
			},
		})}\n`;
	}
	return `${JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: assistantText(index, spec.sessionId) }],
			api: "openai-responses",
			provider: "openai",
			model: "test-model",
			usage: usage(),
			stopReason: "stop",
			timestamp: SESSION_TIMESTAMP_BASE + index,
		},
	})}\n`;
}

async function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
	if (!stream.write(line)) {
		await once(stream, "drain");
	}
}

async function writeSessionJsonl(spec: SessionFileSpec): Promise<void> {
	const stream = createWriteStream(spec.path);
	const header = {
		type: "session",
		version: 3,
		id: spec.sessionId,
		timestamp: new Date(SESSION_TIMESTAMP_BASE).toISOString(),
		cwd: spec.cwd,
	};
	await writeLine(stream, `${JSON.stringify(header)}\n`);
	let parentId: string | null = null;
	for (let index = 0; index < spec.messageCount; index++) {
		await writeLine(stream, sessionEntryLine(spec, index, parentId));
		parentId = entryId(index);
	}
	stream.end();
	await finished(stream);
}

export async function createResumeBenchFixture(messageCount: number): Promise<ResumeBenchFixture> {
	const rootDir = mkdtempSync(join(tmpdir(), "senpi-resume-bench-"));
	const cwd = join(rootDir, "project");
	const sessionDir = join(rootDir, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const resolvedCwd = realpathSync(cwd);

	for (let decoy = 0; decoy < DECOY_SESSION_COUNT; decoy++) {
		const sessionId = `resume-bench-decoy-${String(decoy).padStart(2, "0")}`;
		await writeSessionJsonl({
			path: join(sessionDir, `2026-01-01T00-00-00-${String(decoy).padStart(3, "0")}Z_${sessionId}.jsonl`),
			sessionId,
			cwd: resolvedCwd,
			messageCount: DECOY_MESSAGE_COUNT,
		});
	}

	const selectedPath = join(sessionDir, `2026-01-01T00-00-01-000Z_${SELECTED_SESSION_ID}.jsonl`);
	await writeSessionJsonl({
		path: selectedPath,
		sessionId: SELECTED_SESSION_ID,
		cwd: resolvedCwd,
		messageCount,
	});
	const fixtureBytes = statSync(selectedPath).size;

	return {
		rootDir,
		cwd: resolvedCwd,
		sessionDir,
		selectedPath,
		selectedId: SELECTED_SESSION_ID,
		fixtureBytes,
		decoySessionCount: DECOY_SESSION_COUNT,
	};
}

export function removeResumeBenchFixture(fixture: ResumeBenchFixture): void {
	rmSync(fixture.rootDir, { recursive: true, force: true });
}
