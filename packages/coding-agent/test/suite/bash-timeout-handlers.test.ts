import { describe, expect, it } from "vitest";
import bashTimeoutExtension, {
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	type BashToolInputLike,
} from "../../src/core/extensions/builtin/bash-timeout.js";

type Handler = (event: unknown) => Promise<unknown> | unknown;

interface ApiMock {
	api: { on(event: string, handler: Handler): void };
	handlers: Record<string, Handler[]>;
}

function makeApiMock(): ApiMock {
	const handlers: Record<string, Handler[]> = {};
	return {
		api: {
			on(event: string, handler: Handler) {
				const list = handlers[event] ?? [];
				list.push(handler);
				handlers[event] = list;
			},
		},
		handlers,
	};
}

describe("bashTimeoutExtension factory wiring", () => {
	it("registers tool_call and before_agent_start handlers", () => {
		const { api, handlers } = makeApiMock();

		bashTimeoutExtension(api as never);

		expect(handlers.tool_call?.length).toBe(1);
		expect(handlers.before_agent_start?.length).toBe(1);
	});

	it("mutates bash input.timeout in place when undefined", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);
		const input: BashToolInputLike = { command: "echo hi" };

		await handlers.tool_call[0]({ toolName: "bash", input });

		expect(input.timeout).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
	});

	it("does not touch non-bash tool inputs", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);
		const input: { path: string; timeout?: number } = { path: "/tmp/foo" };

		await handlers.tool_call[0]({ toolName: "read", input });

		expect(input.timeout).toBeUndefined();
	});

	it("caps massive timeouts to max", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);
		const input: BashToolInputLike = { command: "sleep 99999", timeout: 999_999 };

		await handlers.tool_call[0]({ toolName: "bash", input });

		expect(input.timeout).toBe(BASH_MAX_TIMEOUT_SECONDS);
	});

	it("preserves valid in-range timeouts", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);
		const input: BashToolInputLike = { command: "sleep 1", timeout: 30 };

		await handlers.tool_call[0]({ toolName: "bash", input });

		expect(input.timeout).toBe(30);
	});

	it("appends prompt rider to existing systemPrompt", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);

		const result = (await handlers.before_agent_start[0]({
			systemPrompt: "You are helpful.",
		})) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("You are helpful.");
		expect(result.systemPrompt).toContain("Bash Tool Timeout Policy");
		expect(result.systemPrompt).toContain(`Default timeout: ${BASH_DEFAULT_TIMEOUT_SECONDS}s`);
		expect(result.systemPrompt).toContain(`Maximum timeout: ${BASH_MAX_TIMEOUT_SECONDS}s`);
	});

	it("respects PI_BASH_DEFAULT_TIMEOUT_SECONDS env override at factory load time", async () => {
		const original = process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS;
		process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS = "7";
		try {
			const { api, handlers } = makeApiMock();
			bashTimeoutExtension(api as never);
			const input: BashToolInputLike = { command: "echo hi" };

			await handlers.tool_call[0]({ toolName: "bash", input });

			expect(input.timeout).toBe(7);

			const result = (await handlers.before_agent_start[0]({ systemPrompt: "" })) as {
				systemPrompt: string;
			};
			expect(result.systemPrompt).toContain("Default timeout: 7s");
		} finally {
			if (original === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS = original;
		}
	});
});
