import { describe, expect, it, vi } from "vitest";
import {
	BtwSideController,
	type BtwSideControllerOpenOptions,
	type BtwSidePanelPort,
	type BtwSideSurface,
} from "../../src/core/extensions/builtin/btw/side-controller.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createPanel(): BtwSidePanelPort & {
	startTurn: ReturnType<typeof vi.fn>;
	appendText: ReturnType<typeof vi.fn>;
	completeTurn: ReturnType<typeof vi.fn>;
	failTurn: ReturnType<typeof vi.fn>;
	abortTurn: ReturnType<typeof vi.fn>;
	setParentStatus: ReturnType<typeof vi.fn>;
} {
	return {
		startTurn: vi.fn<(question: string) => void>(),
		appendText: vi.fn<(delta: string) => void>(),
		completeTurn: vi.fn<(entry: Parameters<BtwSidePanelPort["completeTurn"]>[0]) => void>(),
		failTurn: vi.fn<(message: string) => void>(),
		abortTurn: vi.fn<() => void>(),
		setParentStatus: vi.fn<(status: "working" | "idle") => void>(),
	};
}

function createSurface(panel = createPanel()) {
	let hidden = false;
	const surface: BtwSideSurface & {
		close: ReturnType<typeof vi.fn>;
		handle: BtwSideSurface["handle"] & {
			setHidden: ReturnType<typeof vi.fn>;
			focus: ReturnType<typeof vi.fn>;
			unfocus: ReturnType<typeof vi.fn>;
		};
	} = {
		panel,
		close: vi.fn<() => void>(),
		handle: {
			setHidden: vi.fn<(next: boolean) => void>((next) => {
				hidden = next;
			}),
			isHidden: () => hidden,
			focus: vi.fn<() => void>(),
			unfocus: vi.fn<() => void>(),
		},
	};
	return surface;
}

function createOptions(overrides: Partial<BtwSideControllerOpenOptions> = {}) {
	const panel = createPanel();
	const surface = createSurface(panel);
	const callbacks = {
		current: undefined as Parameters<BtwSideControllerOpenOptions["createSurface"]>[0] | undefined,
	};
	const options: BtwSideControllerOpenOptions = {
		createSurface: vi.fn(async (nextCallbacks) => {
			callbacks.current = nextCallbacks;
			return surface;
		}),
		runQuestion: vi.fn(async ({ onTextDelta }) => {
			onTextDelta("side ");
			return "side answer";
		}),
		persist: vi.fn(),
		notify: vi.fn(),
		setStatus: vi.fn(),
		initialParentStatus: "working",
		...overrides,
	};
	return { options, panel, surface, callbacks };
}

describe("BtwSideController", () => {
	it("opens the surface before submitting an inline question and persists one completed turn", async () => {
		const { options, panel } = createOptions();
		const controller = new BtwSideController();

		await controller.open(options, "what is happening?");
		await flush();

		expect(panel.startTurn).toHaveBeenCalledWith("what is happening?");
		expect(panel.appendText).toHaveBeenCalledWith("side ");
		expect(panel.completeTurn).toHaveBeenCalledWith({
			question: "what is happening?",
			answer: "side answer",
			timestamp: expect.any(Number),
		});
		expect(options.persist).toHaveBeenCalledOnce();
		expect(controller.isOpen).toBe(true);
		expect(controller.isBusy).toBe(false);
	});

	it("hides and restores the same surface without ending the side lifetime", async () => {
		const { options, surface } = createOptions();
		const controller = new BtwSideController();
		await controller.open(options);

		controller.toggle();
		expect(surface.handle.setHidden).toHaveBeenCalledWith(true);
		expect(surface.handle.unfocus).toHaveBeenCalledOnce();
		expect(options.setStatus).toHaveBeenLastCalledWith("BTW side open · Ctrl+/ to return");
		expect(controller.isVisible).toBe(false);

		controller.toggle();
		expect(surface.handle.setHidden).toHaveBeenCalledWith(false);
		expect(surface.handle.focus).toHaveBeenCalledOnce();
		expect(options.setStatus).toHaveBeenLastCalledWith(undefined);
		expect(controller.isVisible).toBe(true);
	});

	it("aborts and closes exactly once while a late answer is still pending", async () => {
		const answer = deferred<string>();
		let signal: AbortSignal | undefined;
		const { options, panel, surface } = createOptions({
			runQuestion: vi.fn(({ signal: nextSignal }) => {
				signal = nextSignal;
				return answer.promise;
			}),
		});
		const controller = new BtwSideController();
		await controller.open(options, "slow question");
		await flush();

		controller.close();
		controller.close();
		answer.resolve("late answer");
		await flush();

		expect(signal?.aborted).toBe(true);
		expect(surface.close).toHaveBeenCalledOnce();
		expect(panel.completeTurn).not.toHaveBeenCalled();
		expect(options.persist).not.toHaveBeenCalled();
		expect(controller.isOpen).toBe(false);
	});

	it("interrupts only the active answer and keeps the side open for another question", async () => {
		const first = deferred<string>();
		const runQuestion = vi
			.fn<BtwSideControllerOpenOptions["runQuestion"]>()
			.mockImplementationOnce(({ signal }) => {
				signal.addEventListener("abort", () => first.reject(signal.reason), { once: true });
				return first.promise;
			})
			.mockResolvedValueOnce("second answer");
		const { options, panel, surface, callbacks } = createOptions({ runQuestion });
		const controller = new BtwSideController();
		await controller.open(options, "first");
		await flush();

		controller.interrupt();
		await flush();
		expect(panel.abortTurn).toHaveBeenCalledOnce();
		expect(surface.close).not.toHaveBeenCalled();
		expect(controller.isOpen).toBe(true);

		callbacks.current?.onSubmit("second");
		await flush();
		expect(runQuestion).toHaveBeenCalledTimes(2);
		expect(panel.completeTurn).toHaveBeenCalledWith(
			expect.objectContaining({ question: "second", answer: "second answer" }),
		);
	});

	it("closes a surface that resolves after lifecycle teardown without starting its queued question", async () => {
		const pendingSurface = deferred<BtwSideSurface>();
		const { options } = createOptions({
			createSurface: vi.fn(() => pendingSurface.promise),
		});
		const controller = new BtwSideController();
		const opening = controller.open(options, "queued");

		controller.close();
		const lateSurface = createSurface();
		pendingSurface.resolve(lateSurface);
		await opening;
		await flush();

		expect(lateSurface.close).toHaveBeenCalledOnce();
		expect(options.runQuestion).not.toHaveBeenCalled();
		expect(controller.isOpen).toBe(false);
	});

	it("rejects a second submission while the current side answer is streaming", async () => {
		const answer = deferred<string>();
		const { options, callbacks } = createOptions({
			runQuestion: vi.fn(() => answer.promise),
		});
		const controller = new BtwSideController();
		await controller.open(options, "first");
		await flush();

		callbacks.current?.onSubmit("second");

		expect(options.runQuestion).toHaveBeenCalledOnce();
		expect(options.notify).toHaveBeenCalledWith("The side conversation is still answering.", "warning");
		answer.resolve("done");
		await flush();
	});
});
