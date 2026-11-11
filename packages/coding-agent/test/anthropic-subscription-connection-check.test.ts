import { afterEach, describe, expect, it, vi } from "vitest";
import { runClaudeCliConnectionTest } from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-connection-test.ts";

const { lane } = vi.hoisted(() => ({ lane: vi.fn() }));
vi.mock("../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts", () => ({
	queryWithAuthLane: lane,
}));
vi.mock("../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts", () => ({
	loadClaudeAgentSdk: async () => {},
	getSdkBoundary: () => ({ query: vi.fn() }),
}));

afterEach(() => vi.clearAllMocks());

const input = {
	name: "work",
	model: "claude-opus-5-5",
	executable: "/synthetic/claude",
	cwd: "/synthetic/workspace",
	providerSettings: {},
	now: () => 42,
};
describe("Claude subscription account checks (desktop#6444)", () => {
	it("keeps the provider status and message while redacting credentials", async () => {
		const token = `sk-ant-oat01-${"x".repeat(80)}`;
		lane.mockImplementation(async function* () {
			throw Object.assign(new Error(`Model access denied; Bearer ${token}`), { status: 403 });
		});

		const check = await runClaudeCliConnectionTest(input);

		expect(check).toMatchObject({
			model: input.model,
			outcome: "failed",
			status: 403,
			message: "Model access denied; Bearer [REDACTED]",
			at: 42,
		});
		expect(JSON.stringify(check)).not.toContain(token);
	});

	it("keeps the provider's result error and HTTP status", async () => {
		lane.mockReturnValue({
			close() {},
			async *[Symbol.asyncIterator]() {
				yield {
					type: "result",
					subtype: "error_during_execution",
					is_error: true,
					errors: ["This account has no credits for the requested model"],
					api_error_status: 402,
				};
			},
		});

		expect(await runClaudeCliConnectionTest(input)).toMatchObject({
			outcome: "failed",
			status: 402,
			message: expect.stringContaining("This account has no credits for the requested model"),
		});
	});

});
