import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { NoticeSpec } from "../../../src/core/extensions/notice/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { ProviderErrorPresentation } from "../../../src/modes/interactive/provider-error-presentation.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: vi.fn(() => {}),
}));

const primary = "faux/faux-1";
const usage = "API Error: 400 invalid_request_error: credits are required to use this model";
const connection = "Connection error.";

type Exhausted = Extract<AgentSessionEvent, { type: "retry_fallback_exhausted" }>;

async function exhaustAfterPrimary400(harnesses: Harness[]): Promise<Exhausted> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		fallbackNow: () => 0,
		settings: {
			retry: {
				enabled: true,
				baseDelayMs: 1,
				maxRetries: 1,
				fallbackChains: { [primary]: ["faux/faux-2", "faux/faux-3"] },
			},
		},
	});
	harnesses.push(harness);
	const failure = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });
	harness.setResponses([failure(usage), failure(usage), failure(connection)]);
	await harness.session.prompt("replay the report");
	expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-3"]);
	const exhausted = harness.eventsOfType("retry_fallback_exhausted");
	expect(exhausted).toHaveLength(1);
	return exhausted[0] as Exhausted;
}

describe("senpi#4084 fallback exhaustion leads with the primary failure", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
	});

	it("#given the primary fails with a 400 and the last rung with a connection error #then the event carries every rung in order", async () => {
		const exhausted = await exhaustAfterPrimary400(harnesses);

		expect(exhausted.lastError).toBe(connection);
		expect(exhausted.primaryError).toEqual({ model: primary, reason: "billing", error: usage });
		expect(exhausted.failures).toEqual([
			{ model: primary, reason: "billing", error: usage },
			{ model: "faux/faux-2", reason: "billing", error: usage },
			{ model: "faux/faux-3", reason: "transient", error: connection },
		]);
	});

	it("#given that exhaustion #when print mode reports it #then the primary failure comes first", async () => {
		const exhausted = await exhaustAfterPrimary400(harnesses);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			sessionManager: { getHeader: () => undefined },
			agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
			state: { messages: [] },
			extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn((cb: (event: AgentSessionEvent) => void) => {
				listener = cb;
				return () => {};
			}),
			prompt: vi.fn(async () => listener?.(exhausted)),
			reload: vi.fn(async () => {}),
			waitForSettledSessionWork: vi.fn(async () => {}),
		};
		const host = {
			session,
			newSession: vi.fn(),
			fork: vi.fn(),
			switchSession: vi.fn(),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		};
		await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], { mode: "text", initialMessage: "x" });

		const line = errors.mock.calls.map((call) => String(call[0])).find((text) => text.includes("exhausted")) ?? "";
		expect(line).toContain(usage);
		expect(line.indexOf(usage)).toBeLessThan(line.indexOf(connection));
		expect(line).toContain("faux/faux-3");
	});

	it("#given that exhaustion #when the TUI renders it #then the primary failure leads and the later rungs follow", async () => {
		initTheme("dark");
		const exhausted = await exhaustAfterPrimary400(harnesses);
		const notices: NoticeSpec[] = [];
		const providerErrors = new ProviderErrorPresentation(new Container());
		providerErrors.record(connection, false);
		const fixture = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			fallbackAppliedBeforeRetryStart: false,
			clearStatusIndicator: vi.fn(),
			getProviderErrors: () => providerErrors,
			showNoticeBox: (spec: NoticeSpec) => notices.push(spec),
			setExtensionStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
		await Reflect.apply(handleEvent, fixture, [exhausted]);

		const why = String(notices.at(-1)?.why ?? "");
		expect(why.startsWith(`${primary}: ${usage}`)).toBe(true);
		expect(why).toContain(`faux/faux-3: ${connection}`);
		expect(providerErrors.hasActiveRetry).toBe(false);
	});
});
