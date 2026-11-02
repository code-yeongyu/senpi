import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { NoticeSpec } from "../src/core/extensions/notice/index.ts";
import { InteractiveMode, shouldShowRetryIndicator } from "../src/modes/interactive/interactive-mode.ts";

type FallbackLifecycleFixture = {
	isInitialized: true;
	footer: { invalidate: () => void };
	fallbackAppliedBeforeRetryStart: boolean;
	activeStatusIndicatorKind: string | undefined;
	ui: { requestRender: () => void };
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showNoticeBox: (spec: NoticeSpec) => void;
	showStatusIndicator: (indicator: { kind: string }) => void;
	clearStatusIndicator: (kind: string) => void;
	setExtensionStatus: (key: string, text: string | undefined) => void;
};

type InteractiveEventHandler = {
	handleEvent(this: FallbackLifecycleFixture, event: AgentSessionEvent): Promise<void>;
};

function createFixture(): FallbackLifecycleFixture {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		fallbackAppliedBeforeRetryStart: false,
		activeStatusIndicatorKind: "working",
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		showNoticeBox: vi.fn(),
		showStatusIndicator(indicator): void {
			this.activeStatusIndicatorKind = indicator.kind;
		},
		clearStatusIndicator(kind): void {
			if (this.activeStatusIndicatorKind === kind) this.activeStatusIndicatorKind = undefined;
		},
		setExtensionStatus: vi.fn(),
	};
}

const handleEvent = (InteractiveMode.prototype as unknown as InteractiveEventHandler).handleEvent;

describe("InteractiveMode fallback lifecycle", () => {
	it("explains a server-side fallback abort and points at /fallback without a chain", async () => {
		const withChain = createFixture();
		await handleEvent.call(withChain, {
			type: "server_fallback_aborted",
			from: "claude-fable-5",
			to: "claude-opus-4-8",
			chainConfigured: true,
		});
		expect(withChain.showNoticeBox).toHaveBeenCalledWith(
			expect.objectContaining({ tone: "warning", title: expect.stringContaining("claude-fable-5") }),
		);

		const withoutChain = createFixture();
		await handleEvent.call(withoutChain, {
			type: "server_fallback_aborted",
			from: "claude-opus-5",
			to: "claude-opus-4-6",
			chainConfigured: false,
		});
		expect(withoutChain.showNoticeBox).toHaveBeenCalledWith(
			expect.objectContaining({ tone: "warning", why: expect.stringContaining("/fallback") }),
		);
	});

	it("keeps the working indicator active while rendering background probe events", async () => {
		const fixture = createFixture();
		const now = vi.spyOn(Date, "now").mockReturnValue(1000);

		try {
			await handleEvent.call(fixture, {
				type: "retry_probe_scheduled",
				selector: "faux/faux-1",
				atMs: 6000,
				probeIndex: 2,
			});
			expect(fixture.activeStatusIndicatorKind).toBe("working");
			expect(fixture.showStatus).toHaveBeenCalledWith("Probing faux/faux-1 at +5s (#2)");

			await handleEvent.call(fixture, {
				type: "retry_probe_result",
				selector: "faux/faux-1",
				ok: true,
			});
			expect(fixture.activeStatusIndicatorKind).toBe("working");
			expect(fixture.showStatus).toHaveBeenCalledWith("Recovered faux/faux-1 - will restore on next turn");
		} finally {
			now.mockRestore();
		}
	});

	it("renders fallback notices and maintains the fallback footer status", async () => {
		const fixture = createFixture();

		await handleEvent.call(fixture, {
			type: "retry_fallback_applied",
			from: "faux/faux-1",
			to: "faux/faux-2",
			chainKey: "faux/faux-1",
			reason: "transient",
		});
		await handleEvent.call(fixture, {
			type: "retry_fallback_succeeded",
			model: "faux/faux-2",
			chainKey: "faux/faux-1",
		});
		await handleEvent.call(fixture, {
			type: "retry_fallback_reverted",
			from: "faux/faux-2",
			to: "faux/faux-1",
		});
		await handleEvent.call(fixture, {
			type: "retry_fallback_exhausted",
			chainKey: "faux/faux-1",
			lastError: "all models unavailable",
			attempts: [{ model: "faux/faux-1", reason: "error", error: "all models unavailable" }],
		});

		expect(fixture.showNoticeBox).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				tone: "warning",
				title: expect.stringContaining("faux/faux-2"),
				why: expect.stringContaining("transient"),
			}),
		);
		expect(fixture.showNoticeBox).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ tone: "success", title: expect.stringContaining("faux/faux-2") }),
		);
		expect(fixture.showNoticeBox).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({ tone: "accent", title: expect.stringContaining("faux/faux-1") }),
		);
		expect(fixture.showNoticeBox).toHaveBeenNthCalledWith(
			4,
			expect.objectContaining({ tone: "error", why: "all models unavailable" }),
		);
		expect(fixture.setExtensionStatus).toHaveBeenNthCalledWith(1, "fallback", "fallback: faux/faux-2");
		expect(fixture.setExtensionStatus).toHaveBeenNthCalledWith(2, "fallback", undefined);
		expect(fixture.setExtensionStatus).toHaveBeenNthCalledWith(3, "fallback", undefined);
	});
});

it("renders a failure status line when retry_probe_result has ok === false", async () => {
	const fixture = createFixture();
	const now = vi.spyOn(Date, "now").mockReturnValue(1000);

	try {
		await handleEvent.call(fixture, {
			type: "retry_probe_scheduled",
			selector: "faux/faux-1",
			atMs: 6000,
			probeIndex: 2,
		});
		await handleEvent.call(fixture, {
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: false,
		});
		expect(fixture.showStatus).toHaveBeenLastCalledWith("Probe for faux/faux-1 failed - staying on fallback");
	} finally {
		now.mockRestore();
	}
});

it("renders an auth-unavailable skip line when errorMessage is auth-unavailable", async () => {
	const fixture = createFixture();
	const now = vi.spyOn(Date, "now").mockReturnValue(1000);

	try {
		await handleEvent.call(fixture, {
			type: "retry_probe_scheduled",
			selector: "faux/faux-1",
			atMs: 6000,
			probeIndex: 2,
		});
		await handleEvent.call(fixture, {
			type: "retry_probe_result",
			selector: "faux/faux-1",
			ok: false,
			errorMessage: "auth-unavailable",
		});
		expect(fixture.showStatus).toHaveBeenLastCalledWith(
			"Probe for faux/faux-1 skipped - auth unavailable, staying on fallback",
		);
	} finally {
		now.mockRestore();
	}
});

describe("shouldShowRetryIndicator", () => {
	it("suppresses only zero-delay retries that immediately apply a fallback", () => {
		expect(shouldShowRetryIndicator(0, true)).toBe(false);
		expect(shouldShowRetryIndicator(0, false)).toBe(true);
		expect(shouldShowRetryIndicator(1, true)).toBe(true);
	});
});
