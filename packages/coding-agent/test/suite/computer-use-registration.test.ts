import { afterEach, describe, expect, it } from "vitest";
import { COMPUTER_UNAVAILABLE } from "../../src/core/extensions/builtin/computer-use/index.ts";
import { ExecuteToolError } from "../../src/core/extensions/types.ts";
import { type ComputerUseHarness, callTool, createComputerUseHarness } from "./computer-use-harness.ts";

const open: ComputerUseHarness[] = [];

async function harnessWith(options: Parameters<typeof createComputerUseHarness>[0] = {}): Promise<ComputerUseHarness> {
	const created = await createComputerUseHarness(options);
	open.push(created);
	return created;
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((created) => created.cleanup()));
});

describe("computer-use builtin registration", () => {
	it("registers computer_actions only when computer.cuaAdapter is true", async () => {
		// When
		const defaults = await harnessWith();
		const optedIn = await harnessWith({ computer: { cuaAdapter: true } });

		// Then
		const actionsTool = (created: ComputerUseHarness) =>
			created.harness.session.getAllTools().find((candidate) => candidate.name === "computer_actions");
		expect([actionsTool(defaults)?.exposure, actionsTool(optedIn)?.exposure]).toEqual([undefined, "search"]);
	});

	it("registers a search-exposed, inactive computer tool with its kernel prelude and starts no engine", async () => {
		// When
		const { harness, engine } = await harnessWith();

		// Then
		const tool = harness.session.getAllTools().find((candidate) => candidate.name === "computer");
		expect({
			exposure: tool?.exposure,
			exports: tool?.kernelPrelude?.exports,
			active: harness.session.getActiveToolNames().includes("computer"),
			spawned: engine.children.length,
		}).toEqual({ exposure: "search", exports: ["computer"], active: false, spawned: 0 });
	});

	it("does not register on an unsupported host, and /computer on reports it unavailable", async () => {
		// Given
		const computerUse = await harnessWith({ platform: "freebsd" });

		// When
		const reply = await computerUse.command("on");

		// Then
		expect({
			registered: computerUse.harness.session.getAllTools().some((tool) => tool.name === "computer"),
			reply,
		}).toEqual({ registered: false, reply: COMPUTER_UNAVAILABLE });
	});

	it("does not register when computer.enabled is false, and /computer on reports it unavailable", async () => {
		// Given
		const computerUse = await harnessWith({ computer: { enabled: false } });

		// When
		const reply = await computerUse.command("on");

		// Then
		expect({
			registered: computerUse.harness.session.getAllTools().some((tool) => tool.name === "computer"),
			reply,
		}).toEqual({ registered: false, reply: COMPUTER_UNAVAILABLE });
	});

	it("lists computer in tool_search results for a desktop query", async () => {
		// Given
		const { harness } = await harnessWith();

		// When
		const result = await callTool(harness, "tool_search", { query: "click a window" });

		// Then
		expect(result).toMatch(/^- computer — /m);
	});

	it("keeps computer out of tool_search when computer.enabled is false", async () => {
		// Given
		const { harness } = await harnessWith({ computer: { enabled: false } });

		// When
		const result = await callTool(harness, "tool_search", { query: "click a window screenshot" });

		// Then
		expect(result).not.toMatch(/^- computer — /m);
	});

	it("fails an eval-style by-name call closed with unknown_tool when computer.enabled is false", async () => {
		// Given
		const { harness } = await harnessWith({ computer: { enabled: false } });

		// When
		const call = harness.session.executeTool("computer", { action: "capabilities" }, { activateInactiveTool: true });

		// Then
		await expect(call).rejects.toMatchObject({ code: "unknown_tool" });
		await expect(call).rejects.toBeInstanceOf(ExecuteToolError);
	});

	it("reports status without starting the engine", async () => {
		// Given
		const computerUse = await harnessWith();

		// When
		const status = await computerUse.command("status");

		// Then
		expect({
			summary: status.split("\n")[0],
			engine: status.match(/^engine: (.+)$/m)?.[1],
			prelude: status.match(/^prelude: (.+)$/m)?.[1],
			spawned: computerUse.engine.children.length,
		}).toEqual({
			summary: "Computer use: enabled=true active=false engine=not started",
			engine: "not started",
			prelude: "inactive",
			spawned: 0,
		});
	});
});
