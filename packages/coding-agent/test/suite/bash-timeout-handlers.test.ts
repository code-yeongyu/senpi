import { describe, expect, it } from "vitest";
import bashTimeoutExtension, {
	BASH_DEFAULT_TIMEOUT_SECONDS,
	type BashToolInputLike,
} from "../../src/core/extensions/builtin/bash-timeout/index.ts";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

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
	it("registers only the tool_call handler; the terminal section states the timeout facts (senpi#5335)", () => {
		const { api, handlers } = makeApiMock();

		bashTimeoutExtension(api as never);

		expect(handlers.tool_call?.length).toBe(1);
		expect(handlers.before_agent_start).toBeUndefined();
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

	it("preserves massive explicit timeouts", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);
		const input: BashToolInputLike = { command: "sleep 99999", timeout: 999_999 };

		await handlers.tool_call[0]({ toolName: "bash", input });

		expect(input.timeout).toBe(999_999);
	});

	it("preserves valid in-range timeouts", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);
		const input: BashToolInputLike = { command: "sleep 1", timeout: 30 };

		await handlers.tool_call[0]({ toolName: "bash", input });

		expect(input.timeout).toBe(30);
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
		} finally {
			if (original === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS;
			else process.env.PI_BASH_DEFAULT_TIMEOUT_SECONDS = original;
		}
	});
});
