import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Refs #4167: the log must describe the attempted wire request, not the pre-hook payload.
describe("cache prefix at the final transport boundary", () => {
	it("fingerprints post-hook serialized blocks before even a rejected transport call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-prefix-boundary-"));
		const secret = "POST_HOOK_PRIVATE_TEXT";
		let attempts = 0;
		const client = {
			beta: {
				messages: {
					create: (body: { system: unknown }) => {
						attempts++;
						const raw = readFileSync(join(dir, "cache-prefix.jsonl"), "utf8");
						expect(raw).not.toContain(secret);
						const snapshot = JSON.parse(raw.trim().split("\n").at(-1) ?? "");
						expect(snapshot.system[0].hash).toBe(
							createHash("sha256")
								.update(JSON.stringify((body.system as unknown[])[0]))
								.digest("hex"),
						);
						return {
							asResponse: async () => {
								throw Object.assign(new Error("synthetic rejection"), { status: 400 });
							},
						};
					},
				},
			},
		} as unknown as Anthropic;
		try {
			const result = await streamAnthropic(
				getModel("anthropic", "claude-haiku-4-5"),
				normalizeContext({
					systemPrompt: "before hook",
					messages: [{ role: "user", content: "synthetic request", timestamp: 1 }],
				}),
				{
					apiKey: "synthetic-key",
					client,
					env: { SENPI_DEBUG_CACHE_PREFIX: dir },
					onPayload: (payload) => ({
						...(payload as object),
						system: [{ type: "text", text: secret, cache_control: { type: "ephemeral" } }],
					}),
				},
			).result();
			expect(result.stopReason).toBe("error");
			expect(attempts).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
