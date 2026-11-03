import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUEST_SHAPE_LOG_ENV } from "../src/api/anthropic-request-shape-log.ts";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const ORPHAN_400 =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1: `web_search` tool use with id `srvtoolu_a` was found without a corresponding `web_search_tool_result` block"}}';

function rejectingClient(): Anthropic {
	const error = Object.assign(new Error(ORPHAN_400), { status: 400 });
	return {
		beta: {
			messages: {
				create: () => ({
					asResponse: async () => {
						throw error;
					},
				}),
			},
		},
	} as unknown as Anthropic;
}

describe("anthropic request shape log on a rejected request (senpi#3727)", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shape-log-"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("records the request the API rejected, before the SDK throws", async () => {
		// Given: the debug flag points at a log and the API rejects the request
		const logPath = join(dir, "shape.jsonl");
		vi.stubEnv(REQUEST_SHAPE_LOG_ENV, logPath);
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }], tools: [] };

		// When: the request is sent and fails with a 400
		const message = await streamAnthropic(getModel("anthropic", "claude-haiku-4-5"), normalizeContext(context), {
			apiKey: "fake-key",
			client: rejectingClient(),
		}).result();

		// Then: the turn failed, and the rejected request's skeleton is in the log
		expect(message.stopReason).toBe("error");
		const records = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.length).toBeGreaterThanOrEqual(1);
		expect(records[0]).toMatchObject({ provider: "anthropic", messages: [{ index: 0, role: "user" }] });
	});
});
