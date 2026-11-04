// S21a (brain/hand split): prepared is the default pipeline; `legacy` still opts out until S36 removes the flag.
import { Agent, type ToolHost } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { resolveExecutionPipeline } from "../../src/core/execution/pipeline-config.ts";
import { bindPipelineWitness } from "../../src/core/execution/pipeline-witness.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const flag = (value: string | undefined): NodeJS.ProcessEnv =>
	value === undefined ? {} : { SENPI_EXECUTION_PIPELINE: value };

describe("resolving the execution pipeline", () => {
	it.each([
		[undefined, { pipeline: "prepared", named: false }],
		["", { pipeline: "prepared", named: false }],
		["default", { pipeline: "prepared", named: false }],
		["prepared", { pipeline: "prepared", named: true }],
		["legacy", { pipeline: "legacy", named: true }],
	])("SENPI_EXECUTION_PIPELINE=%s resolves to %o", (value, expected) => {
		expect(resolveExecutionPipeline(flag(value))).toEqual(expected);
	});

	it("refuses an unknown value instead of running the default", () => {
		expect(() => resolveExecutionPipeline(flag("fused"))).toThrow(
			'SENPI_EXECUTION_PIPELINE must be legacy, prepared or default, got "fused"',
		);
	});
});

describe("binding the pipeline to a session's agent", () => {
	const fixedHost: ToolHost = {
		execute: async () => ({ messages: [], terminate: false }),
	};
	const agentWith = (toolHost?: ToolHost): Agent =>
		new Agent(toolHost === undefined ? { streamFn: streamSimple } : { streamFn: streamSimple, toolHost });
	const bind = (agent: Agent, value: string | undefined): void =>
		bindPipelineWitness(agent, SessionManager.inMemory(), () => "/work", resolveExecutionPipeline(flag(value)));

	it.each([
		[undefined, true],
		["default", true],
		["prepared", true],
		["legacy", false],
	])(
		"SENPI_EXECUTION_PIPELINE=%s installs the prepared ToolHost: %s, and never a receipt writer",
		(value, prepared) => {
			const agent = agentWith();
			bind(agent, value);
			expect(agent.toolHost !== undefined).toBe(prepared);
			expect(agent.onExecutionPipeline).toBeUndefined();
		},
	);

	it.each([undefined, "default"])("keeps a ToolHost the session was built with (flag: %s)", (value) => {
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
