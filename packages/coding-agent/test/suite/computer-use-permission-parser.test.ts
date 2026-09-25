import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { type ComputerUseHarness, callTool, createComputerUseHarness } from "./computer-use-harness.ts";

// Every case waits on real engine child-process I/O; the guard only catches a hang, it never times behavior.
const HANG_GUARD = { timeout: 30_000 };

const open: ComputerUseHarness[] = [];

async function harnessWith(options: Parameters<typeof createComputerUseHarness>[0]): Promise<ComputerUseHarness> {
	const created = await createComputerUseHarness(options);
	open.push(created);
	return created;
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((created) => created.cleanup()));
});

function lastToolResultIsError(computerUse: ComputerUseHarness): boolean | undefined {
	const result = [...computerUse.harness.session.messages].reverse().find((message) => message.role === "toolResult");
	return result?.role === "toolResult" ? result.isError : undefined;
}

describe("computer permission parser through the real permission-system", HANG_GUARD, () => {
	it("maps computer calls to their tier once the builtin registered the parser", async () => {
		// Given: the computer-use session_start registered the parser.
		await harnessWith({});

		// When
		const requests = createBuiltinParserRegistry().parse(
			"computer",
			{ action: "call", chain: [{ method: "click", args: [5, 5] }] },
			"/work",
		);

		// Then
		expect(requests).toEqual([{ permission: "computer", patterns: ["exec"], always: ["exec"] }]);
	});

	it("blocks a click chain under computer:exec=deny before the click reaches the engine", async () => {
		// Given
		const computerUse = await harnessWith({ permission: "computer:exec=deny" });

		// When
		await callTool(computerUse.harness, "computer", { action: "call", chain: [{ method: "click", args: [5, 5] }] });

		// Then
		expect({ isError: lastToolResultIsError(computerUse), clicked: computerUse.methods().includes("click") }).toEqual(
			{
				isError: true,
				clicked: false,
			},
		);
	});

	it("lets a screenshot chain through under computer:exec=deny", async () => {
		// Given
		const computerUse = await harnessWith({ permission: "computer:exec=deny" });

		// When
		await callTool(computerUse.harness, "computer", { action: "call", chain: [{ method: "screenshot" }] });

		// Then
		expect({
			isError: lastToolResultIsError(computerUse),
			captured: computerUse.methods().includes("capture"),
		}).toEqual({ isError: false, captured: true });
	});

	it("asks exactly once under computer=ask and runs the click after an allow reply", async () => {
		// Given
		const computerUse = await harnessWith({ permission: "computer=ask", promptReplies: ["Allow once"] });

		// When
		await callTool(computerUse.harness, "computer", {
			action: "run",
			code: "await desktop.screenshot(); await desktop.click(5, 5); return 'clicked';",
		});

		// Then
		expect({
			prompts: computerUse.prompts.length,
			isError: lastToolResultIsError(computerUse),
			clicked: computerUse.methods().includes("click"),
		}).toEqual({ prompts: 1, isError: false, clicked: true });
	});
});
