import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionLogger } from "../../../src/core/session-log.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function readSessionLog(harness: Harness): Array<Record<string, unknown>> {
	let raw: string;
	try {
		raw = readFileSync(join(harness.tempDir, "agent", "logs", "session.log"), "utf-8").trim();
	} catch {
		return [];
	}
	return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emitSessionEvent(harness: Harness, event: Record<string, unknown>): void {
	const emit = Reflect.get(harness.session, "_emit");
	if (typeof emit !== "function") throw new Error("Expected AgentSession._emit");
	emit.call(harness.session, event);
}

describe("session.log lines name their session, provider and model (senpi#2541)", () => {
	it("provider_error carries the session id, provider and model", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "400: insufficient credits" }),
		]);

		await harness.session.prompt("hello");
		await harness.session.waitForSettledSessionWork();

		const line = readSessionLog(harness).find((entry) => entry.event === "provider_error");
		expect(line).toMatchObject({
			sessionId: harness.sessionManager.getSessionId(),
			provider: harness.session.model?.provider,
			model: harness.session.model?.id,
			error: "400: insufficient credits",
		});
	});

	it("two sessions logging into one agent dir are told apart by session id", async () => {
		const first = await createHarness();
		harnesses.push(first);
		const second = await createHarness({ siblingOf: first });
		harnesses.push(second);
		const end = { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false };

		emitSessionEvent(first, end);
		emitSessionEvent(second, end);

		const decisions = readSessionLog(first).filter((entry) => entry.event === "compaction_decision");
		expect(decisions.map((entry) => entry.sessionId)).toEqual([
			first.sessionManager.getSessionId(),
			second.sessionManager.getSessionId(),
		]);
		expect(first.sessionManager.getSessionId()).not.toBe(second.sessionManager.getSessionId());
		expect(decisions[0]).toMatchObject({ provider: first.session.model?.provider, model: first.session.model?.id });
	});

	it("provider and model pass the allowlist while unlisted fields are still dropped", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "session-log-allowlist-"));
		const lines: string[] = [];
		try {
			const logger = createSessionLogger(agentDir, { sink: (line) => lines.push(line) });
			logger.warn("provider_error", { provider: "p", model: "m", prompt: "user text", toolArgs: "{}" });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}

		const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(entry).toMatchObject({ provider: "p", model: "m" });
		expect(entry).not.toHaveProperty("prompt");
		expect(entry).not.toHaveProperty("toolArgs");
	});
});
