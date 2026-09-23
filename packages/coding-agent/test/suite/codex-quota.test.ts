import { describe, expect, it } from "vitest";
import { classifyCredentialFailure } from "../../src/core/credential-pool/classify.ts";
import { admitCodexQuota } from "../../src/core/credential-pool/codex-quota.ts";
import type { RotationSlot } from "../../src/core/credential-pool/rotation-stream.ts";

const now = 1_000_000;
const quota = (used: number, credits = false, allowed = used < 100) => ({
	rate_limit: { allowed, limit_reached: used >= 100, primary_window: { used_percent: used } },
	credits: { has_credits: credits, balance: credits ? "100" : "0" },
});
const available = (slots: RotationSlot[]) =>
	slots
		.filter(
			(slot) =>
				slot.blockReason !== "auth_error" &&
				slot.blockReason !== "account_disabled" &&
				!(slot.blockedUntil !== undefined && slot.blockedUntil > now),
		)
		.map((slot) => slot.name);

describe("Codex paid quota admission", () => {
	it.each(["You have hit your ChatGPT usage limit.", "You have hit your usage limit."])(
		"classifies provider quota-limit prose without an HTTP status: %s",
		(message) => {
			expect(classifyCredentialFailure(new Error(message))).toMatchObject({
				kind: "failover",
				block: { reason: "rate_limit" },
			});
		},
	);
	it.each([20, 100])("reads cooling accounts without unblocking generation (%i percent)", async (used) => {
		const lookedUp: string[] = [];
		const slots = await admitCodexQuota(
			{
				providerId: "chatgpt-subscription",
				getCodexUsage: async (slot) => {
					lookedUp.push(slot.name);
					return quota(slot.name === "cooling" ? used : 100, slot.name === "paid");
				},
			},
			[
				{ name: "cooling", lane: "stored", blockReason: "rate_limit", blockedUntil: now + 60_000 },
				{ name: "paid", lane: "stored" },
			],
		);
		expect(lookedUp).toContain("cooling");
		expect(available(slots)).toEqual(used === 100 ? ["paid"] : []);
		expect(slots.find((slot) => slot.name === "cooling")?.blockedUntil).toBe(now + 60_000);
	});

	it.each(["auth_error", "account_disabled"] as const)("treats %s quota as unknown", async (blockReason) => {
		const slots = await admitCodexQuota(
			{
				providerId: "chatgpt-subscription",
				getCodexUsage: async () => quota(100, true),
			},
			[
				{ name: "unknown", lane: "stored", blockReason },
				{ name: "paid", lane: "stored" },
			],
		);
		expect(available(slots)).toEqual([]);
	});

	it("does not confuse denial with quota exhaustion", async () => {
		const slots = await admitCodexQuota(
			{
				providerId: "chatgpt-subscription",
				getCodexUsage: async () => quota(20, true, false),
			},
			[{ name: "denied", lane: "stored" }],
		);
		expect(available(slots)).toEqual([]);
	});

	it.each(["error", "malformed"])("preserves healthy included quota when another account is %s", async (mode) => {
		const slots = await admitCodexQuota(
			{
				providerId: "chatgpt-subscription",
				getCodexUsage: async (slot) => {
					if (slot.name === "unknown") {
						if (mode === "error") throw new Error("test transport failure");
						return {};
					}
					return quota(slot.name === "included" ? 20 : 100, slot.name === "paid");
				},
			},
			["unknown", "included", "paid"].map((name) => ({ name, lane: "stored" })),
		);
		expect(available(slots)).toEqual(["included"]);
	});

	it("requires exhaustion of matching model-specific quota as well", async () => {
		const slots = await admitCodexQuota(
			{
				providerId: "chatgpt-subscription",
				modelId: "test-model",
				getCodexUsage: async () => ({
					...quota(100, true),
					additional_rate_limits: [{ normal_model_slug: "test-model", rate_limit: quota(10).rate_limit }],
				}),
			},
			[{ name: "included", lane: "stored" }],
		);
		expect(slots[0]?.quotaTier).toBe(0);
	});

	it("propagates cancellation instead of making an admission decision", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled test");
		controller.abort(reason);
		await expect(
			admitCodexQuota(
				{
					providerId: "chatgpt-subscription",
					signal: controller.signal,
					getCodexUsage: async () => {
						throw reason;
					},
				},
				[{ name: "cancelled", lane: "stored" }],
			),
		).rejects.toBe(reason);
	});
});
