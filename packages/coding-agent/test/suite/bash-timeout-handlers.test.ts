import { describe, expect, it } from "vitest";
import bashTimeoutExtension, {
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	type BashToolInputLike,
} from "../../src/core/extensions/builtin/bash-timeout/index.ts";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

function ctxWithApi(api: string): { model: { api: string } } {
	return { model: { api } };
}

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

	it("appends prompt rider to existing systemPrompt", async () => {
		const { api, handlers } = makeApiMock();
		bashTimeoutExtension(api as never);

		const result = (await handlers.before_agent_start[0]({
			systemPrompt: "You are helpful.",
		})) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("You are helpful.");
		expect(result.systemPrompt).toContain("Bash Tool Timeout Policy");
		expect(result.systemPrompt).toContain(`Default timeout: ${BASH_DEFAULT_TIMEOUT_SECONDS}s`);
		expect(result.systemPrompt).toContain(`Recommended maximum timeout: ${BASH_MAX_TIMEOUT_SECONDS}s`);
		expect(result.systemPrompt).toContain("process kill deadline");
		expect(result.systemPrompt.toLowerCase()).not.toContain("prompt cache");
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

	it("omits the auto-detach promise when native Anthropic bash makes the PTY tool step aside", async () => {
		process.env.PI_ANTHROPIC_BASH = "1";
		try {
			const { api, handlers } = makeApiMock();
			bashTimeoutExtension(api as never);

			const result = (await handlers.before_agent_start[0](
				{ systemPrompt: "BASE" },
				ctxWithApi("anthropic-messages"),
			)) as { systemPrompt: string };

			expect(result.systemPrompt).toContain("Bash Tool Timeout Policy");
			expect(result.systemPrompt).not.toContain("auto-detaches");
			expect(result.systemPrompt).not.toContain("Foreground blocking stops");
		} finally {
			delete process.env.PI_ANTHROPIC_BASH;
		}
	});

	it("keeps the auto-detach promise for a non-anthropic model while native bash is enabled", async () => {
		process.env.PI_ANTHROPIC_BASH = "1";
		try {
			const { api, handlers } = makeApiMock();
			bashTimeoutExtension(api as never);

			const result = (await handlers.before_agent_start[0](
				{ systemPrompt: "BASE" },
				ctxWithApi("openai-completions"),
			)) as { systemPrompt: string };

			expect(result.systemPrompt).toContain("auto-detaches");
		} finally {
			delete process.env.PI_ANTHROPIC_BASH;
		}
	});

	it("names the configured foreground window instead of a hardcoded 60s", async () => {
		process.env.PI_BASH_FOREGROUND_SECONDS = "25";
		try {
			const { api, handlers } = makeApiMock();
			bashTimeoutExtension(api as never);

			const result = (await handlers.before_agent_start[0]({ systemPrompt: "BASE" })) as {
				systemPrompt: string;
			};

			expect(result.systemPrompt).toContain("25s window");
			expect(result.systemPrompt).not.toContain("60s window");
		} finally {
			delete process.env.PI_BASH_FOREGROUND_SECONDS;
		}
	});
});
