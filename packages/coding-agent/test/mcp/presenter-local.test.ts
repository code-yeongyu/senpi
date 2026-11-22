import { expect, it, vi } from "vitest";
import { markMcpFormPresented, type McpFormInput } from "../../src/core/mcp-form-types.ts";
import { registerLocalMcpPresenter } from "../../src/modes/interactive/mcp-local-presenter.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";
import { privateMcpForms } from "../../src/core/mcp-form-types.ts";

it("reuses one local authority across UI contexts in the same session binding", () => {
	const tui = mrtrTui(undefined, undefined, true);
	try {
		const next = tui.host.createExtensionUIContext();
		expect(privateMcpForms(next)).toBe(privateMcpForms(tui.ui));
	} finally {
		tui.lose();
	}
});

function input(presentationSignal: AbortSignal): McpFormInput {
	return {
		operationId: "operation",
		inputId: "input",
		round: 0,
		message: "private-message",
		server: { label: "configured-server", source: "user" },
		schema: { type: "object", properties: {} },
		operationSignal: new AbortController().signal,
		presentationSignal,
		deadlineMs: 1000,
	};
}

it("the local presenter admits once after complete form review, not per primitive", async () => {
	const admission = vi.fn();
	const tui = mrtrTui(async (_title, choices, options) => {
		expect(admission).not.toHaveBeenCalled();
		markMcpFormPresented(options);
		return choices.includes("Submit") ? "Submit" : choices[0];
	});
	const lifetime = new AbortController();
	try {
		const presentation = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, admission).capture();
		if (!presentation) throw new Error("Missing local presenter");
		expect(await presentation.present(input(new AbortController().signal))).toMatchObject({
			kind: "result",
			result: { action: "accept", content: {} },
			source: "presenter_action",
			humanAdmission: true,
		});
		expect(admission).toHaveBeenCalledTimes(1);
		expect(tui.events).toEqual([]);
	} finally {
		lifetime.abort();
		tui.lose();
	}
});

it.each([false, true])("presentation loss uses actual rendered state (%s), never delivery", async (rendered) => {
	const started = Promise.withResolvers<void>();
	const tui = mrtrTui(
		(_title, _choices, options) =>
			new Promise((resolve) => {
				if (!options?.signal) throw new Error("Missing modal lifetime");
				options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
				if (rendered) markMcpFormPresented(options);
				started.resolve();
			}),
	);
	const lifetime = new AbortController();
	const lost = new AbortController();
	const admission = vi.fn();
	try {
		const presentation = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, admission).capture();
		if (!presentation) throw new Error("Missing local presenter");
		const result = presentation.present(input(lost.signal));
		await started.promise;
		lost.abort();
		expect(await result).toMatchObject(
			rendered
				? { kind: "result", result: { action: "cancel" }, humanAdmission: false }
				: { kind: "processing_failure", humanAdmission: false },
		);
		expect(admission).not.toHaveBeenCalled();
		expect(tui.events).toEqual([]);
	} finally {
		lifetime.abort();
		tui.lose();
	}
});

// senpi#4210: concurrent operations must retain the terminal's FIFO presentation contract.
it("queues local authority forms until the preceding form settles", async () => {
	const shown = Promise.withResolvers<void>();
	const submit = Promise.withResolvers<string>();
	let forms = 0;
	const tui = mrtrTui(async (_title, choices, options) => {
		markMcpFormPresented(options);
		if (choices.includes("Submit") && ++forms === 1) {
			shown.resolve();
			return submit.promise;
		}
		return choices.includes("Submit") ? "Submit" : choices[0];
	});
	const lifetime = new AbortController();
	const admission = vi.fn();
	try {
		const presentation = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, admission).capture();
		if (!presentation) throw new Error("Missing local presenter");
		const first = presentation.present(input(lifetime.signal));
		await shown.promise;
		const second = presentation.present({ ...input(lifetime.signal), operationId: "second" });
		expect(forms).toBe(1);
		submit.resolve("Submit");
		expect(await first).toMatchObject({ kind: "result", result: { action: "accept" } });
		expect(await second).toMatchObject({ kind: "result", result: { action: "accept" } });
		expect(forms).toBe(2);
		expect(admission).toHaveBeenCalledTimes(2);
	} finally {
		submit.resolve("Submit");
		lifetime.abort();
		tui.lose();
	}
});

it("a failed local collector settles its form without revoking future forms", async () => {
	let fail = true;
	const tui = mrtrTui(async (_title, choices, options) => {
		if (fail) {
			fail = false;
			throw new Error("synthetic collector failure");
		}
		markMcpFormPresented(options);
		return choices.includes("Submit") ? "Submit" : choices[0];
	});
	const lifetime = new AbortController();
	try {
		const binding = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, vi.fn());
		const presentation = binding.capture();
		if (!presentation) throw new Error("Missing local presenter");
		expect(await presentation.present(input(lifetime.signal))).toMatchObject({
			kind: "processing_failure",
			humanAdmission: false,
		});
		expect(binding.capture()?.ready()).toBe(true);
		expect(await presentation.present(input(lifetime.signal))).toMatchObject({
			kind: "result",
			result: { action: "accept" },
		});
	} finally {
		lifetime.abort();
		tui.lose();
	}
});

it.each(["operation", "presentation", "timeout"])("settles a queued form on %s without rendering it", async (cause) => {
	vi.useFakeTimers();
	const shown = Promise.withResolvers<void>();
	const submit = Promise.withResolvers<string>();
	let forms = 0;
	const tui = mrtrTui(async (_title, choices, options) => {
		markMcpFormPresented(options);
		if (choices.includes("Submit")) {
			forms++;
			shown.resolve();
			return submit.promise;
		}
		return choices[0];
	});
	const lifetime = new AbortController();
	const operation = new AbortController();
	const view = new AbortController();
	try {
		const presentation = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, vi.fn()).capture();
		if (!presentation) throw new Error("Missing local presenter");
		const first = presentation.present(input(lifetime.signal));
		await shown.promise;
		const second = presentation.present({
			...input(view.signal),
			operationSignal: operation.signal,
			deadlineMs: 10,
		});
		if (cause === "operation") operation.abort();
		else if (cause === "presentation") view.abort();
		else await vi.advanceTimersByTimeAsync(10);
		expect(await second).toMatchObject({
			kind: cause === "operation" ? "operation_aborted" : "processing_failure",
			humanAdmission: false,
		});
		submit.resolve("Submit");
		expect(await first).toMatchObject({ kind: "result", result: { action: "accept" } });
		expect(forms).toBe(1);
	} finally {
		submit.resolve("Submit");
		lifetime.abort();
		tui.lose();
		vi.useRealTimers();
	}
});
