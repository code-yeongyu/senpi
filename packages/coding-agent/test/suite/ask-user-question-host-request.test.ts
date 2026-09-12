import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

type HostQuestionRequest = {
	id: string;
	method: "question";
	requestId: string;
	toolCallId: string;
	waitForAnswer: boolean;
	questions: QuestionRequest["questions"];
	timeout: number;
	askedAtMs: number;
	deadlineAtMs: number;
	remainingMs: number;
};

function buildHostRequest(overrides: Partial<HostQuestionRequest> = {}): HostQuestionRequest {
	const questions: QuestionRequest["questions"] = [
		{
			id: "auth",
			header: "Auth",
			question: "Which auth method?",
			options: [
				{ label: "OAuth", description: "Token login" },
				{ label: "API key", description: "Static key" },
			],
			multiSelect: false,
		},
	];
	return {
		id: "ui-1",
		method: "question",
		requestId: "req-1",
		toolCallId: "tc-1",
		waitForAnswer: true,
		questions,
		timeout: 30 * 60_000,
		askedAtMs: 1_000,
		deadlineAtMs: 1_001_000,
		remainingMs: 1_799_000,
		...overrides,
	};
}

function overlayResponse(status: QuestionResponse["status"], extra: Partial<QuestionResponse> = {}): QuestionResponse {
	return {
		status,
		answers: { auth: { selected: ["OAuth"] } },
		unanswered: [],
		...extra,
	};
}

type OverlayOptions = {
	timeout?: number;
	onProgress?: (draft: { answers?: QuestionResponse["answers"]; comment?: string }) => void;
};

type OverlayFn = (request: QuestionRequest, opts?: OverlayOptions) => Promise<QuestionResponse>;

async function callHandleHostUiRequest(
	fakeThis: unknown,
	request: HostQuestionRequest,
): Promise<{ type?: string; id?: string; answers?: unknown; comment?: string; cancelled?: boolean }> {
	const handler = Reflect.get(InteractiveMode.prototype, "handleHostUiRequest");
	if (typeof handler !== "function") throw new Error("InteractiveMode.handleHostUiRequest is missing");
	return handler.call(fakeThis, request);
}

describe("handleHostUiRequest question case", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the overlay and replies with answers plus comment", async () => {
		const showQuestionOverlay = vi.fn<OverlayFn>(async () =>
			overlayResponse("comment-submitted", { comment: "ship it", unanswered: ["auth"] }),
		);
		const fakeThis = { showQuestionOverlay, runtimeHost: { sendHostUiProgress: vi.fn() } };

		const response = await callHandleHostUiRequest(fakeThis, buildHostRequest());

		expect(response).not.toBeUndefined();
		expect(response).toEqual({
			type: "extension_ui_response",
			id: "ui-1",
			answers: { auth: { selected: ["OAuth"] } },
			comment: "ship it",
		});
	});

	it("replies with cancelled:true when the overlay resolves cancelled", async () => {
		const showQuestionOverlay = vi.fn(async () =>
			overlayResponse("cancelled", { answers: {}, unanswered: ["auth"] }),
		);
		const fakeThis = { showQuestionOverlay, runtimeHost: { sendHostUiProgress: vi.fn() } };

		const response = await callHandleHostUiRequest(fakeThis, buildHostRequest());

		expect(response).toEqual({ type: "extension_ui_response", id: "ui-1", cancelled: true });
	});

	it("passes the wire fields through as a canonical question request", async () => {
		const showQuestionOverlay = vi.fn<OverlayFn>(async () => overlayResponse("answered"));
		const fakeThis = { showQuestionOverlay, runtimeHost: { sendHostUiProgress: vi.fn() } };

		await callHandleHostUiRequest(fakeThis, buildHostRequest());

		expect(showQuestionOverlay).toHaveBeenCalledTimes(1);
		const [request, opts] = showQuestionOverlay.mock.calls[0];
		expect(request).toMatchObject({ requestId: "req-1", waitForAnswer: true });
		expect(request.questions).toHaveLength(1);
		expect(request.questions[0]).toMatchObject({ id: "auth", header: "Auth" });
		expect(opts?.timeout).toBe(1_799_000);
		expect(typeof opts?.onProgress).toBe("function");
	});

	it("debounces progress drafts into 1s-spaced extension_ui_progress records", async () => {
		vi.useFakeTimers();
		let resolveOverlay: ((response: QuestionResponse) => void) | undefined;
		const showQuestionOverlay = vi.fn<OverlayFn>(
			() =>
				new Promise<QuestionResponse>((resolve) => {
					resolveOverlay = resolve;
				}),
		);
		const sendHostUiProgress = vi.fn();
		const fakeThis = { showQuestionOverlay, runtimeHost: { sendHostUiProgress } };

		try {
			const pending = callHandleHostUiRequest(fakeThis, buildHostRequest());
			const [, opts] = showQuestionOverlay.mock.calls[0];
			if (!opts?.onProgress) throw new Error("showQuestionOverlay was not given an onProgress callback");

			opts.onProgress({ answers: { auth: { selected: ["OAuth"] } }, comment: undefined });
			opts.onProgress({ answers: { auth: { selected: ["OAuth"] } }, comment: "par" });
			expect(sendHostUiProgress).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1_000);
			expect(sendHostUiProgress).toHaveBeenCalledTimes(1);
			expect(sendHostUiProgress).toHaveBeenLastCalledWith({
				type: "extension_ui_progress",
				id: "ui-1",
				answers: { auth: { selected: ["OAuth"] } },
				comment: "par",
			});

			opts.onProgress({ answers: { auth: { selected: ["API key"] } }, comment: "par" });
			opts.onProgress({ answers: {}, comment: "final" });
			vi.advanceTimersByTime(1_000);
			expect(sendHostUiProgress).toHaveBeenCalledTimes(2);
			expect(sendHostUiProgress).toHaveBeenLastCalledWith({
				type: "extension_ui_progress",
				id: "ui-1",
				answers: {},
				comment: "final",
			});

			resolveOverlay?.(overlayResponse("comment-submitted", { comment: "final" }));
			const response = await pending;
			expect(response).toEqual({
				type: "extension_ui_response",
				id: "ui-1",
				answers: { auth: { selected: ["OAuth"] } },
				comment: "final",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
