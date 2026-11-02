import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { PromptTemplate } from "../../../src/core/prompt-templates.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

export interface ResumeFixture {
	readonly h: Harness;
	readonly api: () => ExtensionAPI;
	readonly toolStarted: () => Promise<void>;
	readonly releaseTool: () => void;
}

export const runRef = { kind: "dag", id: "r1" } as const;
export const image = { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" } as const;

/** A faux session whose `hold` tool waits for the test, one gate per call (senpi#3811 resume settlement). */
export async function resumeFixture(
	options: { unattended?: boolean; prompts?: PromptTemplate[]; notify?: (message: string) => void } = {},
): Promise<ResumeFixture> {
	const waiters: Array<() => void> = [];
	const gates: Array<() => void> = [];
	let api: ExtensionAPI | undefined;
	const capture = (pi: ExtensionAPI) => {
		api = pi;
	};
	const prompts = options.prompts;
	const h = await createHarness({
		...(options.unattended === true
			? { sessionStartEvent: { type: "session_start", reason: "resume", attended: false } }
			: {}),
		...(prompts === undefined
			? { extensionFactories: [capture] }
			: {
					resourceLoader: {
						...createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([capture]) }),
						getPrompts: () => ({ prompts, diagnostics: [] }),
					},
				}),
		tools: [
			{
				name: "hold",
				label: "Hold",
				description: "Deterministic interrupt boundary, one gate per call",
				parameters: Type.Object({}),
				execute: async () => {
					waiters.shift()?.();
					await new Promise<void>((resolve) => gates.push(resolve));
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	const notify = options.notify;
	await h.session.bindExtensions({
		mode: "rpc",
		shutdownHandler: () => {},
		...(notify === undefined ? {} : { uiContext: createTestUiContext({ notify: (message) => notify(message) }) }),
	});
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		...Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`later turn ${index}`)),
	]);
	return {
		h,
		api: () => {
			if (api === undefined) throw new Error("extension binding unavailable");
			return api;
		},
		toolStarted: () => new Promise<void>((resolve) => waiters.push(resolve)),
		releaseTool: () => gates.shift()?.(),
	};
}

/** A Stop issued from inside the next `before_agent_start`, so it lands while that turn is being admitted. */
export function stopDuringNextAdmission(fixture: ResumeFixture): void {
	let armed = true;
	fixture.api().on("before_agent_start", () => {
		if (!armed) return;
		armed = false;
		void fixture.h.session.stop();
	});
}

export function settlesWithin<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} never settled`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function settle(fixture: ResumeFixture): Promise<void> {
	await fixture.h.session.waitForIdle();
	// The resume consumes held input after its turn's send settles; wait for that, not for a tick count.
	await fixture.h.session.resumeSettled();
	await fixture.h.session.waitForIdle();
}
