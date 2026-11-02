/**
 * The canonical expected-snapshot builder (`lib/expected-entries.mjs`) builds a session's expected
 * entry list outside the server response path: one line at a time, with the built package's real
 * `describeUsageLimitEntry`. It needs `npm run build` first (the transform is imported from `dist`).
 */
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { describeUsageLimitEntry } from "../../src/core/retry-fallback/usage-limit.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { collectExpected, readLines, streamExpectedEntries } from "./lib/expected-entries.mjs";

const root = mkdtempSync(join(tmpdir(), "expected-entries-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const USAGE_LIMIT_TEXT = "You've hit your session limit · resets 3pm";

function usage() {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function smallSession(): string {
	const dir = join(root, "small");
	const manager = SessionManager.create(root, dir);
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: 2,
	});
	manager.appendMessage({
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "error",
		errorMessage: USAGE_LIMIT_TEXT,
		timestamp: 3,
	});
	const file = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
	if (file === undefined) throw new Error("session file was not written");
	return join(dir, file);
}

describe("expected-snapshot builder", () => {
	const small = smallSession();

	test("on a small fixture the list deep-equals the legacy get_entries entries", async () => {
		const legacy = SessionManager.open(small).getEntries().map(describeUsageLimitEntry);
		const expected = await collectExpected(small);
		expect(expected).toEqual(legacy);
		const last = expected.at(-1);
		expect(last?.type === "message" && last.message.role === "assistant" && last.message.errorMessage).not.toBe(
			USAGE_LIMIT_TEXT,
		);
	});

	test("on a 200 MB fixture it yields the transformed entry holding at most one parsed line", async () => {
		const [header, userLine, , usageLimitLine] = readFileSync(small, "utf8").split("\n");
		const template = JSON.parse(userLine ?? "{}");
		const big = join(root, "big.jsonl");
		const fd = openSync(big, "w");
		writeSync(fd, `${header}\n`);
		const filler = "x".repeat(100_000);
		let parentId = template.parentId ?? null;
		for (let index = 0; index < 2_000; index++) {
			const id = `filler${index}`;
			const entry = { ...template, id, parentId, message: { ...template.message, content: [{ type: "text", text: filler }] } };
			writeSync(fd, `${JSON.stringify(entry)}\n`);
			parentId = id;
		}
		writeSync(fd, `${JSON.stringify({ ...JSON.parse(usageLimitLine ?? "{}"), parentId })}\n`);
		closeSync(fd);

		let pulled = 0;
		let yielded = 0;
		let maxOutstanding = 0;
		const spyLines = async function* (path: string) {
			for await (const line of readLines(path)) {
				pulled += 1;
				maxOutstanding = Math.max(maxOutstanding, pulled - 1 - yielded);
				yield line;
			}
		};
		let lastEntry: { type: string; message?: { errorMessage?: string; errorCause?: unknown } } | undefined;
		for await (const entry of streamExpectedEntries(big, { readLines: spyLines })) {
			yielded += 1;
			lastEntry = entry;
		}
		expect(yielded).toBe(2_001);
		expect(maxOutstanding).toBeLessThanOrEqual(1);
		expect(lastEntry?.message?.errorCause).toEqual({ type: "usage_limit", scope: "account" });
		expect(lastEntry?.message?.errorMessage).not.toBe(USAGE_LIMIT_TEXT);
	}, 120_000);

	test("a truncated last line fails with torn_tail", async () => {
		const content = readFileSync(small, "utf8");
		const torn = join(root, "torn.jsonl");
		const fd = openSync(torn, "w");
		writeSync(fd, content.slice(0, content.length - 20));
		closeSync(fd);
		await expect(collectExpected(torn)).rejects.toMatchObject({ code: "torn_tail" });
	});
});
