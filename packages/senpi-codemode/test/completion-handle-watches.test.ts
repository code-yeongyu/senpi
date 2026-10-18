import { describe, expect, it } from "vitest";
import { CompletionHandles } from "../src/handles/completion-handles.ts";

function pendingCompletion(handles: CompletionHandles) {
	return handles.start({ run: () => new Promise(() => undefined), deadlineMs: Date.now() + 60_000 });
}

describe("Given a watch over a completion handle", () => {
	it("When the watch is closed, then the registry stops tracking it", () => {
		const handles = new CompletionHandles();
		const watch = handles.watch([pendingCompletion(handles)]);
		expect(handles.openWatches).toBe(1);

		watch.close();

		expect(handles.openWatches).toBe(0);
		handles.dispose();
	});

	it("When the caller stops iterating its updates, then the registry stops tracking the watch", async () => {
		const handles = new CompletionHandles();
		const watch = handles.watch([pendingCompletion(handles)]);
		const iterator = watch.updates[Symbol.asyncIterator]();

		await iterator.return?.();

		expect(handles.openWatches).toBe(0);
		handles.dispose();
	});
});
