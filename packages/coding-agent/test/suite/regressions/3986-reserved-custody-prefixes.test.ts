import { describe, expect, it } from "vitest";
import { createLifecycleApi, ReservedCustodyKey } from "../../../src/core/extensions/lifecycle-api.ts";
import { SessionLifecycleController } from "../../../src/core/session-lifecycle.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

function controller(): SessionLifecycleController {
	const manager = SessionManager.inMemory();
	const lifecycle = new SessionLifecycleController({
		sessionId: manager.getSessionId(),
		entries: [],
		append: (record) => manager.appendCustomEntry("session-lifecycle", record),
		appendChild: (record) => manager.appendCustomEntry("child-lifecycle", record),
		appendCustody: (record) => manager.appendCustomEntry("work-custody", record),
		emit: () => {},
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			holds: [],
			human: [],
		}),
	});
	lifecycle.restoreComplete();
	return lifecycle;
}

function extensionApi(engine: SessionLifecycleController) {
	return createLifecycleApi(() => ({
		obligations: engine.obligations,
		reportChild: (report) => engine.reportChild(report),
		markRunCompleted: ({ runId }) => engine.markRunCompleted(runId),
	}));
}

// senpi#3986: the engine owns the `delivery:` and `wake-source:` custody keys, so an extension may not use them.
describe("engine custody key prefixes are reserved for the engine", () => {
	it.each(["delivery:x", "wake-source:monitor"])("refuses an extension open of %s with a typed error", (key) => {
		// Given an extension's lifecycle API.
		const engine = controller();
		const api = extensionApi(engine);

		// When the extension opens custody under an engine prefix.
		// Then it throws a typed error and nothing is opened.
		expect(() => api.obligations.open(key, "background")).toThrow(ReservedCustodyKey);
		expect(engine.obligations.activeCount).toBe(0);
	});

	it("refuses an extension transfer into an engine prefix and keeps the current custody", () => {
		// Given extension-owned custody.
		const engine = controller();
		const token = extensionApi(engine).obligations.open("result:review", "children");

		// When the extension transfers it under an engine prefix.
		// Then it throws and the original custody stays open.
		expect(() => token.transfer("delivery:review")).toThrow(ReservedCustodyKey);
		expect(engine.obligations.active.map((record) => record.key)).toEqual(["result:review"]);
	});

	it("still lets extensions use other keys and the engine use its own prefixes", () => {
		// Given an extension and the engine sharing one session.
		const engine = controller();
		const api = extensionApi(engine);

		// When each opens custody under its own keys.
		const extension = api.obligations.open("result:review", "children");
		engine.obligations.open("delivery:engine:1", "children");

		// Then both are open, and the extension token keeps working.
		expect(engine.obligations.active.map((record) => record.key).sort()).toEqual([
			"delivery:engine:1",
			"result:review",
		]);
		const next = extension.transfer("result:review-2");
		next.close("consumed");
		expect(engine.obligations.active.map((record) => record.key)).toEqual(["delivery:engine:1"]);
	});
});
