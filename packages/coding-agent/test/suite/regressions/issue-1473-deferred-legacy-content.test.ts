import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { loadEntriesFromFile, SessionManager } from "../../../src/core/session-manager.ts";
import { getMessageText } from "../harness.ts";
import { resumeRuntime } from "../issue-1473-runtime-support.ts";

const MiB = 1024 * 1024;
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const cases = [
	{ version: 1, sizes: [65], layout: "single65MiB" },
	{ version: 1, sizes: [33, 33], layout: "aggregate66MiB" },
	{ version: 2, sizes: [65], layout: "single65MiB" },
	{ version: 2, sizes: [33, 33], layout: "aggregate66MiB" },
];
function fixture(path: string, cwd: string, version: number, sizes: number[]) {
	const timestamp = new Date(0).toISOString();
	const texts = sizes.map((size, i) => `${String.fromCharCode(65 + i)} `.repeat((size * MiB) / 2));
	const messages = [
		...texts.map((text) => ({ role: "user", content: text, timestamp: 0 })),
		fauxAssistantMessage("durable tail"),
	];
	const entries = messages.map((message, i) => ({
		type: "message",
		id: `entry${i}`,
		parentId: i ? `entry${i - 1}` : null,
		timestamp,
		message,
	}));
	const compact = {
		type: "compaction",
		id: "compact",
		parentId: `entry${entries.length - 1}`,
		timestamp,
		summary: "summary",
		tokensBefore: 1,
		...(version === 1 ? { firstKeptEntryIndex: 1 } : { firstKeptEntryId: "entry0" }),
	};
	writeFileSync(
		path,
		[
			JSON.stringify({ type: "session", version, id: "legacy", timestamp, cwd }),
			...entries.map((e) => JSON.stringify(e)),
			JSON.stringify(compact),
		].join("\n"),
	);
	return texts.map((text) => ({ length: text.length, sha: hash(text) }));
}
function userContent(messages: readonly unknown[]) {
	return messages
		.filter((m) => typeof m === "object" && m !== null && "role" in m && m.role === "user")
		.map((m) => {
			const text = getMessageText(m);
			return { length: text.length, sha: hash(text) };
		});
}

// PR #1473 ghN2N: use actual 64MiB overflow, never a raised or mocked resident budget.
it.each(cases)(
	"PR1473 ghN2N: deferred legacy rewrite preserves evicted transcript content (v$version $layout)",
	async ({ version, sizes }) => {
		let cancel = true;
		const host = await resumeRuntime((pi) => {
			pi.on("session_before_switch", () => ({ cancel }));
		}, 128_000_000);
		try {
			const path = join(host.cwd, "legacy.jsonl");
			const expected = fixture(path, host.cwd, version, sizes);
			const before = hash(readFileSync(path));
			const prepared = SessionManager.prepareOpen(path);
			const manager = prepared.sessionManager;
			// Admission must see materialized content before migrated IDs exist on disk.
			expect.soft(userContent(manager.buildSessionContext().messages)).toEqual(expected);
			const cancelled = prepared.beginCommit();
			cancelled.rollback();
			expect(hash(readFileSync(path))).toBe(before);
			const live = host.runtime.session;
			expect(await host.runtime.switchSession(path)).toEqual({ cancelled: true });
			expect(host.runtime.session).toBe(live);
			expect(hash(readFileSync(path))).toBe(before);
			cancel = false;
			expect(await host.runtime.switchSession(path)).toEqual({ cancelled: false });
			expect.soft(userContent(host.runtime.session.messages)).toEqual(expected);
			const persisted = loadEntriesFromFile(path);
			expect(persisted[0]).toMatchObject({ type: "session", version: 3 });
			expect(userContent(persisted.flatMap((e) => (e.type === "message" ? [e.message] : [])))).toEqual(expected);
			const ids = new Set(persisted.map((e) => e.id));
			for (const entry of persisted) {
				if (entry.type === "session") continue;
				if (entry.parentId !== null) expect(ids.has(entry.parentId)).toBe(true);
				if (entry.type === "compaction") expect(ids.has(entry.firstKeptEntryId)).toBe(true);
			}
			expect(readFileSync(path, "utf8").includes("senpi-resident-string:v1:")).toBe(false);
			const accepted = host.runtime.session.sessionManager;
			expect(accepted.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * MiB);
			expect(accepted.getResidentStoreStats().blobCount).toBe(sizes.length === 1 ? 0 : 1);
			expect(userContent(accepted.buildSessionContext().messages)).toEqual(expected);
			expect(userContent(SessionManager.open(path).buildSessionContext().messages)).toEqual(expected);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

// Actual SDK admission must reject the full large context; markers used to undercount it.
it("PR1473 ghN2N: legacy budget rejection emits veto without shutdown and preserves bytes", async () => {
	let vetoes = 0;
	let shutdowns = 0;
	const host = await resumeRuntime((pi) => {
		pi.on("session_before_switch", () => {
			vetoes++;
		});
		pi.on("session_shutdown", () => {
			shutdowns++;
		});
	});
	try {
		const path = join(host.cwd, "rejected.jsonl");
		fixture(path, host.cwd, 1, [65]);
		const before = hash(readFileSync(path));
		const live = host.runtime.session;
		await expect(host.runtime.switchSession(path)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(vetoes).toBe(1);
		expect(shutdowns).toBe(0);
		expect(host.runtime.session).toBe(live);
		expect(hash(readFileSync(path))).toBe(before);
	} finally {
		await host.dispose();
	}
}, 60_000);

it("PR1473 ghN2N: staged appends remain materialized through persistence", async () => {
	const host = await resumeRuntime();
	try {
		const path = join(host.cwd, "append.jsonl");
		writeFileSync(
			path,
			JSON.stringify({
				type: "session",
				version: 1,
				id: "pending",
				timestamp: new Date(0).toISOString(),
				cwd: host.cwd,
			}),
		);
		const prepared = SessionManager.prepareOpen(path);
		const text = "P".repeat(65 * MiB);
		prepared.sessionManager.appendMessage({ role: "user", content: text, timestamp: 0 });
		prepared.sessionManager.appendMessage(fauxAssistantMessage("tail"));
		const expected = [{ length: text.length, sha: hash(text) }];
		expect.soft(userContent(prepared.sessionManager.buildSessionContext().messages)).toEqual(expected);
		prepared.beginCommit().commit();
		expect(userContent(loadEntriesFromFile(path).flatMap((e) => (e.type === "message" ? [e.message] : [])))).toEqual(
			expected,
		);
		expect(prepared.sessionManager.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * MiB);
	} finally {
		await host.dispose();
	}
}, 60_000);
