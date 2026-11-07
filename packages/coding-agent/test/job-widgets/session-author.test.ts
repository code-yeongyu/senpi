import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";

import { setJobWidgetAuthorResolver } from "../../src/core/extensions/builtin/job-widgets/index.ts";
import { createSessionJobWidgetAuthor } from "../../src/core/extensions/builtin/job-widgets/session-author.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { controllerFor, FakeJob, RPS_SPEC } from "./author-support.ts";

function modelFor(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "job-widgets-test",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 4096,
	};
}

const SESSION_MODEL = modelFor("session");
const HOST_MODEL = modelFor("host");
const SETTING_MODEL = modelFor("setting");

/** A session whose own model is set, and whose model runtime records every request it is asked to send. */
function sessionContext(response: AssistantMessage) {
	const calls: Model<Api>[] = [];
	const ctx = {
		cwd: "/work",
		model: SESSION_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === SETTING_MODEL.provider && id === SETTING_MODEL.id ? SETTING_MODEL : undefined,
			modelRuntime: {
				streamSimple: (model: Model<Api>, _context: Context, _options: SimpleStreamOptions) => {
					calls.push(model);
					return { result: async () => response };
				},
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, calls };
}

const SPEC_ANSWER = fauxAssistantMessage(fauxToolCall("respond", RPS_SPEC), { stopReason: "toolUse" });
const FAILED_ANSWER = fauxAssistantMessage([], { stopReason: "error", errorMessage: "usage limit" });

let withdraw: (() => void) | undefined;
afterEach(() => {
	withdraw?.();
	withdraw = undefined;
});

describe("session job widget author: designated models only", () => {
	it("never asks the session's model when no designated model resolves, and reports why", async () => {
		const { ctx, calls } = sessionContext(SPEC_ANSWER);
		const { controller } = controllerFor(createSessionJobWidgetAuthor(() => ctx, undefined));
		expect(await controller.maybeRequest(new FakeJob("bg_1"))).toEqual({
			kind: "unavailable",
			reason: "no_designated_model",
		});
		expect(calls).toEqual([]);
	});

	it("never asks the session's model when the host route answers nothing or the setting names no known model", async () => {
		const { ctx, calls } = sessionContext(SPEC_ANSWER);
		withdraw = setJobWidgetAuthorResolver(() => undefined);
		const { controller } = controllerFor(createSessionJobWidgetAuthor(() => ctx, "job-widgets-test/missing"));
		expect(await controller.maybeRequest(new FakeJob("bg_1"))).toEqual({
			kind: "unavailable",
			reason: "no_designated_model",
		});
		expect(calls).toEqual([]);
	});

	it("does not retry a failed designated model on the session's model", async () => {
		const { ctx, calls } = sessionContext(FAILED_ANSWER);
		withdraw = setJobWidgetAuthorResolver(() => HOST_MODEL);
		const { controller } = controllerFor(createSessionJobWidgetAuthor(() => ctx, undefined));
		expect(await controller.maybeRequest(new FakeJob("bg_1"))).toMatchObject({ kind: "failed" });
		expect(calls).toEqual([HOST_MODEL]);
	});

	it("writes the spec with the setting's model first, then the host route's", async () => {
		const host = sessionContext(SPEC_ANSWER);
		withdraw = setJobWidgetAuthorResolver(() => HOST_MODEL);
		const viaHost = controllerFor(createSessionJobWidgetAuthor(() => host.ctx, undefined));
		expect(await viaHost.controller.maybeRequest(new FakeJob("bg_1"))).toMatchObject({ kind: "installed" });
		expect(host.calls).toEqual([HOST_MODEL]);

		const setting = sessionContext(SPEC_ANSWER);
		const viaSetting = controllerFor(
			createSessionJobWidgetAuthor(() => setting.ctx, `${SETTING_MODEL.provider}/${SETTING_MODEL.id}`),
		);
		expect(await viaSetting.controller.maybeRequest(new FakeJob("bg_2"))).toMatchObject({ kind: "installed" });
		expect(setting.calls).toEqual([SETTING_MODEL]);
	});
});
