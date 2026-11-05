/**
 * One session writer in its own process, for the K9-F2 cases of test/session-store/node-requires-bun.test.ts
 * (senpi#5822). Under Node (the test sets SENPI_SESSION_STORE=jsonl) it is a developer-hatch writer on the legacy JSONL
 * store; under Bun it binds the session to its durable default store. It holds the session the way the CLI does
 * (`holdSessionFile`), reads one JSON command per stdin line and answers each with one JSON line on stdout. A projection
 * rewrite can be held at a barrier between the store's checks and its file write.
 */
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createJsonlImporter } from "../../src/core/session-import/jsonl-import.ts";
import { holdSessionFile, type SessionHold } from "../../src/core/session-holders.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { DefaultSessionStore } from "../../src/core/session-store/default-store.ts";

type Command =
	| { op: "create"; cwd: string; sessionDir: string; agentDir: string }
	| { op: "open"; file: string; sessionDir: string; agentDir: string }
	| { op: "append"; text: string }
	| { op: "rewrite"; text: string }
	| { op: "release" }
	| { op: "stored" }
	| { op: "list"; cwd: string; sessionDir: string }
	| { op: "close" };

const onBun = process.versions.bun !== undefined;
let manager: SessionManager | undefined;
let hold: SessionHold | undefined;
let bound: DefaultSessionStore | undefined;
let barrier: { reached: () => void; released: Promise<void>; release: () => void } | undefined;
const warnings: string[] = [];

const say = (value: object): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

const textOf = (value: unknown): string | undefined => {
	if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "message") return undefined;
	const message = (value as { message?: { role?: string; content?: unknown } }).message;
	return message?.role === "user" && typeof message.content === "string" ? message.content : undefined;
};

const texts = (values: readonly unknown[]): string[] =>
	values.map(textOf).filter((text): text is string => text !== undefined);

function current(): SessionManager {
	if (manager === undefined) throw new Error("no session is open");
	return manager;
}

async function adopt(next: SessionManager, agentDir: string): Promise<void> {
	await close();
	manager = next;
	const file = next.getSessionFile() ?? "";
	hold = holdSessionFile(file, next.getSessionId(), { cwd: process.cwd(), expectExisting: false });
	next.onProjectionWarning((warning) => warnings.push(`${warning.code}: ${warning.message}`));
	if (!onBun) return;
	const { openDefaultSessionStore } = await import("../../src/core/session-store/default-store.ts");
	bound = await openDefaultSessionStore({ agentDir, sessionId: next.getSessionId() });
	await next.bindDurableStore({
		...bound,
		files: {
			// The store's whole-file projection write; a rewrite the test holds waits here, after the store's checks.
			async replace(path, contents) {
				if (barrier !== undefined) {
					chmodSync(path, 0o644);
					barrier.reached();
					await barrier.released;
				}
				const temporary = `${path}.hatch-peer.tmp`;
				writeFileSync(temporary, contents);
				renameSync(temporary, path);
			},
		},
	});
}

async function close(): Promise<void> {
	await manager?.settleDurableProjection();
	hold?.release();
	hold = undefined;
	manager = undefined;
}

function append(text: string): object {
	try {
		current().appendMessage({ role: "user", content: text, timestamp: Date.now() });
		return { ok: true };
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return { ok: false, code: typeof code === "string" ? code : String(error) };
	}
}

async function run(command: Command): Promise<object> {
	switch (command.op) {
		case "create":
			await adopt(SessionManager.create(command.cwd, command.sessionDir), command.agentDir);
			return { ok: true, file: current().getSessionFile(), id: current().getSessionId() };
		case "open":
			await adopt(SessionManager.open(command.file, command.sessionDir), command.agentDir);
			return { ok: true, id: current().getSessionId(), entries: texts(current().getEntries()) };
		case "append": {
			const result = append(command.text);
			await current().settleDurableProjection();
			return result;
		}
		case "rewrite": {
			// A projection append that fails marks the projection stale; the next write has the store rewrite the file whole.
			const file = current().getSessionFile() ?? "";
			const before = warnings.length;
			let reached!: () => void;
			const atBarrier = new Promise<void>((resolve) => {
				reached = resolve;
			});
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			barrier = { reached, released, release };
			chmodSync(file, 0o444);
			append(command.text);
			if (warnings.length === before) {
				chmodSync(file, 0o644);
				barrier = undefined;
				return { ok: false, code: "projection-did-not-fail" };
			}
			const result = append(`${command.text}+`);
			await atBarrier;
			say({ event: "barrier" });
			await released;
			await current().settleDurableProjection();
			barrier = undefined;
			return result;
		}
		case "release":
			barrier?.release();
			return { ok: true };
		case "stored": {
			if (bound === undefined) throw new Error("the durable store is open only under Bun");
			const importer = createJsonlImporter({ ...bound, admission: { admit: (mutation) => mutation() } });
			const id = current().getSessionId();
			const ledger = await importer.getLedger(current().getSessionFile() ?? "");
			const session = await importer.getSession(id);
			const ledgerSession = ledger === undefined ? undefined : await importer.getSession(ledger.sessionId);
			return {
				id,
				entries: texts(session?.entries ?? []),
				ledgerSessionId: ledger?.sessionId,
				ledgerEntries: texts(ledgerSession?.entries ?? []),
				divergence: ledgerSession?.divergence,
			};
		}
		case "list":
			return { files: (await SessionManager.list(command.cwd, command.sessionDir)).map((info) => info.path) };
		case "close":
			await close();
			return { ok: true };
	}
}

// Commands run one at a time, except `release`, which reaches a rewrite that is waiting at the barrier and has no answer.
let queue = Promise.resolve();
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line) as Command;
	if (command.op === "release") {
		await run(command);
		continue;
	}
	queue = queue.then(async () => {
		try {
			say(await run(command));
		} catch (error) {
			say({ ok: false, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		}
	});
}
await queue;
await close();
