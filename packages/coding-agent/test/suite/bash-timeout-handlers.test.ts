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

describe("bashTimeoutExtension renders the policy for the tools the session holds (#5140)", () => {
	function apiWithTools(names: readonly string[]): ApiMock {
		const mock = makeApiMock();
		return {
			handlers: mock.handlers,
			api: Object.assign(mock.api, { getAllTools: () => names.map((name) => ({ name })) }),
		};
	}

	async function render(names: readonly string[]): Promise<string> {
		const { api, handlers } = apiWithTools(names);
		bashTimeoutExtension(api as never);
		const result = (await handlers.before_agent_start[0]({ systemPrompt: "BASE" })) as
			| { systemPrompt: string }
			| undefined;
		return result?.systemPrompt ?? "BASE";
	}

	it("names the tool.bash call shape from an eval cell when the session routes through eval", async () => {
		const prompt = await render(["eval", "bash", "read"]);

		expect(prompt).toContain("Bash Tool Timeout Policy");
		expect(prompt).toContain("tool.bash({ command, timeout })");
		expect(prompt).not.toContain("The `bash` tool's");
		expect(prompt).not.toMatch(/(^|[^.\w])bash\(\{/);
	});

	it("keeps the direct bash wording when no eval tool is registered", async () => {
		const prompt = await render(["bash", "read"]);

		expect(prompt).toContain("The `bash` tool's `timeout` parameter is the process kill deadline");
		expect(prompt).not.toContain("tool.bash(");
	});

	it("omits the policy when the session has no bash tool to time out", async () => {
		for (const names of [["read"], ["eval", "read"]]) {
			const prompt = await render(names);

			expect(prompt, names.join(",")).toBe("BASE");
		}
	});
});
