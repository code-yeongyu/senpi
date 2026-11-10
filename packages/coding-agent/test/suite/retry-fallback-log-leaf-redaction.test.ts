import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rememberResolvedReferenceValue } from "../../src/core/config-reference-redaction.ts";
import { createFallbackLogger } from "../../src/core/retry-fallback/log.ts";

// omo#12965: every leaf of a fallback-log entry, and every nested key, goes through the same redaction and
// truncation as a string leaf; the serialized line gets a value-only backstop pass that never rewrites a clean line.

const MARKER = "leaf-12965-marker-k3v9";
const DIGITS = "1296500012965";
rememberResolvedReferenceValue(MARKER);
rememberResolvedReferenceValue(DIGITS);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function writtenLine(event: string, data: Record<string, unknown>): Promise<string> {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-fallback-leaf-"));
	dirs.push(agentDir);
	const logger = createFallbackLogger(agentDir);
	logger.warn(event, data);
	await logger.settled();
	return readFileSync(join(agentDir, "logs", "fallback.log"), "utf8").trimEnd();
}

const echoing = Object.assign(() => undefined, { toString: () => `echo ${MARKER}` });

describe("fallback log leaves", () => {
	const cases: readonly [string, unknown, string][] = [
		["a symbol leaf", Symbol(`echo ${MARKER}`), MARKER],
		["a function leaf", echoing, MARKER],
		["a bigint leaf", BigInt(DIGITS), DIGITS],
		["a symbol inside an array", [Symbol(`echo ${MARKER}`)], MARKER],
		["a nested object key", { [`echo ${MARKER}`]: 1 }, MARKER],
	];
	for (const [label, error, remembered] of cases) {
		it(`redacts a remembered value carried by ${label}`, async () => {
			const line = await writtenLine("candidate_failed", { error });

			expect(line).toContain("[redacted]");
			expect(line).not.toContain(remembered);
		});
	}

	it("truncates a symbol leaf like a string leaf", async () => {
		const entry = JSON.parse(await writtenLine("candidate_failed", { error: Symbol("s".repeat(300)) })) as {
			error: string;
		};

		expect(entry.error).toHaveLength(200);
		expect(entry.error.endsWith("...")).toBe(true);
	});

	it("leaves a clean fallback_applied line byte-identical", async () => {
		const data = {
			from: "anthropic/claude-opus-5-5",
			to: "openai/gpt-6-sol-ultra",
			chainKey: "anthropic/claude-opus-5-5:high",
			reason: "transient",
			durationMs: 1234,
		};
		const line = await writtenLine("fallback_applied", data);
		const { ts } = JSON.parse(line) as { ts: string };

		expect(line).toBe(JSON.stringify({ ts, level: "warn", event: "fallback_applied", ...data }));
	});
});
