// S29 (brain/hand split, R24.c part 1): the shipped with-deps example, loaded unmodified by path, behaves the same on
// fused (UI-bound), headless and split-local. Its tool resolves its own npm dependency (`ms`) on the side that runs it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteToolHost } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import { EXTENSION_EVENTS_PLANE, serveExtensionEvents } from "../../src/core/extensions/two-sided-forwarding.ts";
import { cleanupHands, handDirs, openLink, startHand } from "../hand/remote-hand-fixture.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

const withDeps = fileURLToPath(new URL("../../examples/extensions/with-deps/index.ts", import.meta.url));

/**
 * A two-sided policy extension beside the unmodified plugin: it allows the plugin's tool only once a turn started, which
 * only the loop's copy has seen, so on a split session the result matches fused only when its tool_call is forwarded.
 */
const turnGate = join(mkdtempSync(join(tmpdir(), "s29-turn-gate-")), "turn-gate.ts");
writeFileSync(
	turnGate,
	'export default (pi) => { let turn = false; pi.on("before_agent_start", () => { turn = true; }); pi.on("tool_call", (event) => event.toolName === "parse_duration" && !turn ? { block: true, reason: "no turn has started on this copy" } : undefined); };',
);

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

type Placement = "fused" | "headless" | "split-local";

async function toolResults(placement: Placement, paths: readonly string[] = [withDeps]): Promise<string[]> {
	const extensionsResult = await loadExtensions([...paths], process.cwd());
	expect(extensionsResult.errors).toEqual([]);
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	harnesses.push(harness);
	await harness.session.bindExtensions(
		placement === "fused" ? { mode: "rpc", uiContext: createTestUiContext(), shutdownHandler: () => {} } : {},
	);
	if (placement === "split-local") {
		const link = openLink();
		startHand(
			link,
			await handDirs("s29-with-deps"),
			[],
			paths.flatMap((path) => ["-e", path]),
		);
		harness.agent.toolHost = createRemoteToolHost({
			transport: link.brain,
			placement: "split-local",
			planes: { [EXTENSION_EVENTS_PLANE]: serveExtensionEvents(harness.getExtensionRunner()) },
		});
	}
	harness.setResponses([
		fauxAssistantMessage(
			[
				{ ...fauxToolCall("parse_duration", { duration: "2 days" }), id: "call-0" },
				{ ...fauxToolCall("parse_duration", { duration: "soon" }), id: "call-1" },
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("parse two durations");
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult"
			? [
					`${message.isError ? "error" : "ok"} ${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`,
				]
			: [],
	);
}

describe("the unmodified with-deps plugin on every placement (S29, R24.c part 1)", () => {
	it("returns the same results fused, headless and split-local", async () => {
		const fused = await toolResults("fused");

		expect(fused).toEqual(["ok 2 days = 172800000 milliseconds", 'error Invalid duration: "soon"']);
		expect(await toolResults("headless")).toEqual(fused);
		expect(await toolResults("split-local")).toEqual(fused);
	});

	it("keeps a two-sided policy extension's loop state for the plugin's tool on a split session", async () => {
		const fused = await toolResults("fused", [withDeps, turnGate]);

		expect(fused).toEqual(["ok 2 days = 172800000 milliseconds", 'error Invalid duration: "soon"']);
		expect(await toolResults("split-local", [withDeps, turnGate])).toEqual(fused);
	});
});
