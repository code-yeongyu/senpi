import { chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionStore } from "../../../agent/src/durable/session-store.ts";
import {
	createMemoryStoreMedium,
	type MemoryStoreMedium,
	openMemoryStore,
} from "../../../agent/src/durable/store-memory.ts";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ProjectionWarning } from "../../src/core/session-store/durable-binding.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

let dir: string;
let medium: MemoryStoreMedium;

beforeEach(async () => {
	dir = makeTempDir(join(tmpdir(), "s20b-durable-"));
	medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
});

afterEach(() => {
	chmodSync(dir, 0o755);
});

async function durableSession(path?: string): Promise<{ session: SessionManager; warnings: ProjectionWarning[] }> {
	const session = path === undefined ? SessionManager.create(dir, dir) : SessionManager.open(path, dir);
	const warnings: ProjectionWarning[] = [];
	session.onProjectionWarning((warning) => warnings.push(warning));
	await session.bindDurableStore({ store: openMemoryStore(medium), epoch: 1 });
	return { session, warnings };
}

async function storeImage(sessionId: string): Promise<string> {
	const stored = await openSessionStore(openMemoryStore(medium), 1).load(sessionId);
	if (stored === undefined) throw new Error(`the store holds no session ${sessionId}`);
	return [JSON.stringify(stored.header), ...stored.entries.map((entry) => entry.line)]
		.map((line) => `${line}\n`)
		.join("");
}

function fileOf(session: SessionManager): string {
	const file = session.getSessionFile();
	if (file === undefined) throw new Error("the session has no file");
	return file;
}

describe("a SessionManager bound to the durable store (S20b)", () => {
	it("commits every write to the store and projects the JSONL byte for byte", async () => {
		const { session, warnings } = await durableSession();

		const question = session.appendMessage(userMsg("question"));
		session.appendCustomEntry("note", { n: 1 });
		session.appendMessage(assistantMsg("answer"));
		session.appendLabelChange(question, "start");
		session.appendSessionInfo("durable parity");
		await session.settleDurableProjection();

		expect(warnings).toEqual([]);

		const file = fileOf(session);
		expect(readFileSync(file, "utf8")).toBe(await storeImage(session.getSessionId()));
		expect(SessionManager.open(file, dir).getEntries()).toEqual(session.getEntries());
	});

	it.each([0, 1, 2, 5, 20])(
		"raises no warning when a write lands %i microtasks after a successful projection",
		async (yields) => {
			const { session, warnings } = await durableSession();
			session.appendMessage(userMsg("question"));
			for (let index = 0; index < yields; index++) await Promise.resolve();
			session.appendMessage(assistantMsg("answer"));
			await session.settleDurableProjection();

			expect(warnings).toEqual([]);
			expect(readFileSync(fileOf(session), "utf8")).toBe(await storeImage(session.getSessionId()));
		},
	);

	it("keeps the first entry when the session file cannot be created, warns, and projects it once the directory is writable", async () => {
		const { session, warnings } = await durableSession();
		chmodSync(dir, 0o555);
		try {
			expect(() => session.appendMessage(userMsg("question"))).not.toThrow();
		} finally {
			chmodSync(dir, 0o755);
		}
		expect(warnings.map((warning) => warning.code)).toEqual(["EACCES"]);
		expect(session.getEntries()).toHaveLength(1);

		session.appendMessage(assistantMsg("answer"));
		await session.settleDurableProjection();

		expect(warnings).toHaveLength(1);
		expect(readFileSync(fileOf(session), "utf8")).toBe(await storeImage(session.getSessionId()));
	});

	it("commits to the store the writes that landed while the bind was still pending", async () => {
		const session = SessionManager.create(dir, dir);
		const warnings: ProjectionWarning[] = [];
		session.onProjectionWarning((warning) => warnings.push(warning));
		const bound = session.bindDurableStore({ store: openMemoryStore(medium), epoch: 1 });
		session.appendMessage(userMsg("written while the bind was pending"));
		await bound;
		session.appendMessage(assistantMsg("after the bind"));
		await session.settleDurableProjection();

		expect(warnings).toEqual([]);
		const image = await storeImage(session.getSessionId());
		expect(image).toContain("written while the bind was pending");
		expect(readFileSync(fileOf(session), "utf8")).toBe(image);
	});

	it("throws a store refusal on the same call and takes nothing", async () => {
		const { session } = await durableSession();
		session.appendMessage(userMsg("question"));
		const file = fileOf(session);
		const before = readFileSync(file, "utf8");
		const entries = session.getEntries();
		await openMemoryStore(medium).claim(1, 2);

		expect(() => session.appendMessage(assistantMsg("answer"))).toThrow();

		expect(session.getEntries()).toEqual(entries);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("keeps an entry whose projection failed, warns with the path and errno, and the next write rewrites the JSONL", async () => {
		const { session, warnings } = await durableSession();
		session.appendMessage(userMsg("question"));
		const file = fileOf(session);
		chmodSync(file, 0o444);

		const id = session.appendMessage(assistantMsg("answer"));

		expect(session.getEntries().map((entry) => entry.id)).toContain(id);
		expect(warnings).toEqual([expect.objectContaining({ path: file, code: "EACCES" })]);
		session.appendCustomEntry("note", { after: true });
		await session.settleDurableProjection();
		expect(readFileSync(file, "utf8")).toBe(await storeImage(session.getSessionId()));
	});

	it("warns on every write while the projection keeps failing", async () => {
		const { session, warnings } = await durableSession();
		session.appendMessage(userMsg("question"));
		chmodSync(fileOf(session), 0o444);
		chmodSync(dir, 0o555);

		session.appendMessage(assistantMsg("one"));
		session.appendMessage(assistantMsg("two"));
		await session.settleDurableProjection();

		expect(warnings.map((warning) => warning.code)).toEqual(["EACCES", "EACCES"]);
		session.appendMessage(assistantMsg("three"));
		await session.settleDurableProjection();
		expect(warnings.map((warning) => warning.code)).toEqual(["EACCES", "EACCES", "EACCES"]);
	});

	it("reprojects the JSONL from the store on the next open after a crash between the commit and the projection", async () => {
		const first = await durableSession();
		first.session.appendMessage(userMsg("question"));
		const file = fileOf(first.session);
		chmodSync(file, 0o444);
		chmodSync(dir, 0o555);
		const lost = first.session.appendMessage(assistantMsg("answer"));
		const sessionId = first.session.getSessionId();
		chmodSync(dir, 0o755);
		chmodSync(file, 0o644);

		const reopened = await durableSession(file);

		expect(reopened.session.getEntries().map((entry) => entry.id)).toContain(lost);
		expect(readFileSync(file, "utf8")).toBe(await storeImage(sessionId));
	});
});
