import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { HumanInputAdmittedEvent } from "../../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function seamFixture() {
	let api: ExtensionAPI | undefined;
	let context: ExtensionContext | undefined;
	const fixture = await createIdentityHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
		],
	});
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([
		fauxAssistantMessage("one"),
		fauxAssistantMessage("two"),
		fauxAssistantMessage("three"),
	]);
	const seen: Array<HumanInputAdmittedEvent & { userMessagesAtCall: number }> = [];
	fixture.session.onHumanInputAdmitted((event) => {
		const userMessagesAtCall = fixture.session.messages.filter((message) => message.role === "user").length;
		seen.push({ ...event, userMessagesAtCall });
	});
	if (api === undefined || context === undefined) throw new Error("extension binding unavailable");
	return { fixture, api, context, seen };
}

describe("senpi#3811 human-input seam", () => {
	it("reports interactive RPC input synchronously, before it is admitted", async () => {
		const { fixture, seen } = await seamFixture();
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });

		await human.send({ type: "prompt", message: "hello" });
		await fixture.session.waitForIdle();

		expect(seen.map((event) => event.kind)).toEqual(["prompt"]);
		expect(seen[0]?.userMessagesAtCall).toBe(0);
	});

	it("reports RPC input by its entry point whatever the connection role, and never extension or automatic deliveries", async () => {
		const { fixture, api, seen } = await seamFixture();
		const roleless = fixture.bind();

		await roleless.send({ type: "prompt", message: "typed through a plain RPC client" });
		await fixture.session.waitForIdle();
		api.sendUserMessage("from an extension");
		await fixture.session.waitForIdle();
		await fixture.session.sendCustomMessage(
			{ customType: "senpi-monitor:event", content: "wake", display: false },
			{ triggerTurn: true },
		);
		await fixture.session.waitForIdle();

		expect(seen.map((event) => event.kind)).toEqual(["prompt"]);
	});
	it("reports TUI input and resume", async () => {
		const { fixture, seen } = await seamFixture();

		await fixture.session.prompt("typed in the TUI");
		await fixture.session.resumeSession();

		expect(seen.map((event) => event.kind)).toEqual(["prompt", "resume"]);
	});

	it("fixes the interactive_user role at its first declaration", async () => {
		const { fixture } = await seamFixture();
		const conn = fixture.bind();
		await conn.send({ type: "set_client_info", capabilities: [] });

		const flip = (await conn.send({ type: "set_client_info", capabilities: ["interactive_user"] })) as {
			success: boolean;
			error?: string;
		};

		expect(flip.success).toBe(false);
		expect(flip.error).toContain("connection_role_fixed");
	});
	it("reports each human input exactly once, also when a held session routes a steer through prompt", async () => {
		const { fixture, api, context, seen } = await seamFixture();
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		Reflect.get(fixture.session, "_engineTurnHold").addHold("unattended");

		await human.send({ type: "steer", message: "while held" });
		await fixture.session.waitForIdle();
		// ask-user's human answer: release the question input, then deliver through the extension API.
		releaseQuestionInput(context);
		api.sendUserMessage("my answer");
		await fixture.session.waitForIdle();

		expect(seen.map((event) => event.kind)).toEqual(["steer", "answer"]);
	});
});
