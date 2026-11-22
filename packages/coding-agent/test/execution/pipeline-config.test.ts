// S21a / S36 (senpi#5412, senpi#5728): the loop has one pipeline; the test/QA-only variable can only name it.
import { Agent, type ToolHost } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { resolveExecutionPipeline } from "../../src/core/execution/pipeline-config.ts";
import { bindPipelineWitness } from "../../src/core/execution/pipeline-witness.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const flag = (value: string | undefined): NodeJS.ProcessEnv =>
	value === undefined ? {} : { SENPI_EXECUTION_PIPELINE: value };

describe("resolving SENPI_EXECUTION_PIPELINE", () => {
	it.each([
		[undefined, false],
		["", false],
		["default", false],
		["prepared", true],
	])("%j names the pipeline: %s", (value, named) => {
		expect(resolveExecutionPipeline(flag(value))).toEqual({ named });
	});

	it.each(["legacy", "fused"])("refuses %s instead of running the default under its name", (value) => {
		expect(() => resolveExecutionPipeline(flag(value))).toThrow(
			`SENPI_EXECUTION_PIPELINE must be prepared or default, got "${value}"`,
		);
	});
});

describe("binding a session's agent", () => {
	const fixedHost: ToolHost = {
		execute: async () => ({ messages: [], terminate: false }),
	};
	const agentWith = (toolHost?: ToolHost): Agent =>
		new Agent(toolHost === undefined ? { streamFn: streamSimple } : { streamFn: streamSimple, toolHost });
	const bind = (agent: Agent, value: string | undefined): void =>
		bindPipelineWitness(agent, SessionManager.inMemory(), () => "/work", resolveExecutionPipeline(flag(value)));

	it.each([undefined, "default", "prepared"])(
		"%j installs no ToolHost (the loop's default is prepared) and never a receipt writer",
		(value) => {
			const agent = agentWith();
			bind(agent, value);
			expect(agent.toolHost).toBeUndefined();
			expect(agent.onExecutionPipeline).toBeUndefined();
		},
	);

	it.each([undefined, "default"])("keeps a ToolHost the session was built with (flag: %j)", (value) => {
		const agent = agentWith(fixedHost);
		bind(agent, value);
		expect(agent.toolHost).toBe(fixedHost);
	});

	it("refuses to replace that ToolHost when prepared is named", () => {
		const agent = agentWith(fixedHost);
		expect(() => bind(agent, "prepared")).toThrow(
			"SENPI_EXECUTION_PIPELINE=prepared cannot replace the ToolHost this session was built with",
		);
		expect(agent.toolHost).toBe(fixedHost);
	});
});
