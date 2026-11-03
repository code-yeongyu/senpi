// S29 (brain/hand split, R24.c part 1): the shipped with-deps example, loaded unmodified by path, behaves the same on
// fused (UI-bound), headless and split-local. Its tool resolves its own npm dependency (`ms`) on the side that runs it.
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

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

type Placement = "fused" | "headless" | "split-local";

async function toolResults(placement: Placement): Promise<string[]> {
	const extensionsResult = await loadExtensions([withDeps], process.cwd());
	expect(extensionsResult.errors).toEqual([]);
	const harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
	harnesses.push(harness);
	await harness.session.bindExtensions(
		placement === "fused" ? { mode: "rpc", uiContext: createTestUiContext(), shutdownHandler: () => {} } : {},
	);
	if (placement === "split-local") {
		const link = openLink();
		startHand(link, await handDirs("s29-with-deps"), [], ["-e", withDeps]);
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
});
