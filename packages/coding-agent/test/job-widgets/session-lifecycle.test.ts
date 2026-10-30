import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import jobWidgetsExtension from "../../src/core/extensions/builtin/job-widgets/extension.ts";
import {
	closeJobWidgetSession,
	getJobWidgetState,
	type JobWidgetAuthor,
	type JobWidgetAuthorRequest,
	openJobWidgetSession,
	parkJobWidgetSession,
	registerJobWidgetSource,
	TextTap,
} from "../../src/core/extensions/builtin/job-widgets/index.ts";
import {
	tapBackgroundSession,
	untapBackgroundSession,
} from "../../src/core/extensions/builtin/terminal/job-widget-tap.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

/** An author that never answers until its request is aborted, so jobs stay pending and visible. */
function pendingAuthor(calls: JobWidgetAuthorRequest[] = []): JobWidgetAuthor {
	return (request, signal) => {
		calls.push(request);
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)));
	};
}

function fakeBackgroundSession(initial: string) {
	const outputs = new Set<(chunk: string) => void>();
	const exits = new Set<() => void>();
	const disposes = new Set<() => void>();
	let full = initial;
	const runtime = {
		startedAtMs: Date.now(),
		fullOutput: () => full,
		onOutput: (listener: (chunk: string) => void) => {
			outputs.add(listener);
			return () => outputs.delete(listener);
		},
		onDispose: (listener: () => void) => {
			disposes.add(listener);
			return () => disposes.delete(listener);
		},
		session: { onExit: (listener: () => void) => exits.add(listener) },
	} as unknown as TerminalRuntimeSession;
	return {
		runtime,
		write(chunk: string): void {
			full += chunk;
			for (const listener of [...outputs]) listener(chunk);
		},
		exit(): void {
			for (const listener of [...exits]) listener();
		},
		dispose(): void {
			for (const listener of [...disposes]) listener();
		},
		get outputListeners(): number {
			return outputs.size;
		},
	};
}

const jobIds = (sessionId: string): string[] => getJobWidgetState(sessionId)?.jobs.map((job) => job.id) ?? [];

describe("job widget sessions across reloads", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("applies the re-read author delay and obfuscation when a reload re-binds the session", async () => {
		const sessionId = "reload_settings";
		const calls: JobWidgetAuthorRequest[] = [];
		openJobWidgetSession(sessionId, { authorAfterMs: 60_000, author: pendingAuthor(calls), publish: () => {} });
		const tap = new TextTap("out", "command output");
		const handle = registerJobWidgetSource({
			sessionId,
			id: "bash_1",
			kind: "bash",
			sources: [tap],
			brief: { command: "deploy" },
			startedAtMs: Date.now(),
		});
		tap.append("step 1\nstep 2\nstep 3 on bluefin\n");
		handle?.notify();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveLength(0);

		parkJobWidgetSession(sessionId);
		openJobWidgetSession(sessionId, {
			authorAfterMs: 0,
			author: pendingAuthor(calls),
			publish: () => {},
			obfuscate: () => ({ push: (text) => text.replaceAll("bluefin", "[host]"), finish: () => "" }),
		});
		await vi.advanceTimersByTimeAsync(1_000);
		try {
			expect(calls).toHaveLength(1);
			expect(JSON.stringify(calls[0])).not.toContain("bluefin");
			expect(getJobWidgetState(sessionId)?.jobs[0]?.view?.stage).toBe("step 3 on [host]");
		} finally {
			closeJobWidgetSession(sessionId);
		}
	});

	it("drops taps when a reload turns widgets off and taps running sessions again when they come back", async () => {
		const sessionId = "reload_retap";
		const open = (): void =>
			openJobWidgetSession(sessionId, { authorAfterMs: 0, author: pendingAuthor(), publish: () => {} });
		open();
		const running = fakeBackgroundSession("a\nb\nc\n");
		const typedInto = fakeBackgroundSession("x\ny\nz\n");
		const exitsWhileOff = fakeBackgroundSession("p\nq\nr\n");
		const brief = { command: "make", description: "make" };
		tapBackgroundSession(sessionId, "bash_1", running.runtime, brief);
		tapBackgroundSession(sessionId, "bash_2", typedInto.runtime, brief);
		tapBackgroundSession(sessionId, "bash_3", exitsWhileOff.runtime, brief);
		untapBackgroundSession(typedInto.runtime);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(jobIds(sessionId)).toEqual(["bash_1", "bash_3"]);

		// The reload's new generation finds `jobWidgets.enabled: false`: the parked session closes.
		parkJobWidgetSession(sessionId);
		closeJobWidgetSession(sessionId);
		expect([running.outputListeners, typedInto.outputListeners, exitsWhileOff.outputListeners]).toEqual([0, 0, 0]);
		running.write("d\n");
		exitsWhileOff.exit();

		open();
		try {
			expect([running.outputListeners, typedInto.outputListeners, exitsWhileOff.outputListeners]).toEqual([1, 0, 0]);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(jobIds(sessionId)).toEqual(["bash_1"]);
			expect(getJobWidgetState(sessionId)?.jobs[0]?.view?.lines).toBe(4);
		} finally {
			for (const session of [running, typedInto, exitsWhileOff]) session.dispose();
			closeJobWidgetSession(sessionId);
		}
		expect(running.outputListeners).toBe(0);
	});
});

describe("the job widgets extension", () => {
	it("keeps model_select's context lazy instead of reading every guarded getter", () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		jobWidgetsExtension({
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		} as unknown as ExtensionAPI);
		const staleGetter = {
			get() {
				throw new Error("This extension instance is stale after session replacement or reload.");
			},
			enumerable: true,
			configurable: true,
		};
		const staleContext = Object.defineProperties(
			{},
			{ cwd: staleGetter, sessionManager: staleGetter, model: staleGetter },
		);
		expect(() => handlers.get("model_select")?.({ model: { id: "next" } }, staleContext)).not.toThrow();
	});
});
