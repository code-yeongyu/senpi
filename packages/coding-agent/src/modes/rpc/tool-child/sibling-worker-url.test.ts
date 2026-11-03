// senpi#3566 todo 4: a job worker entry follows its caller's extension, so the built package (`.js`) starts the same
// worker the source tree (`.ts`) does. The QA run against the built host failed because the entry was pinned to `.ts`.
import { describe, expect, it } from "vitest";
import { siblingWorkerUrl } from "./gated-worker.ts";

describe("siblingWorkerUrl", () => {
	it("uses the caller's own extension", () => {
		expect(
			siblingWorkerUrl("./module-job-worker.ts", "file:///pkg/dist/modes/rpc/tool-child/module-job.js").href,
		).toBe("file:///pkg/dist/modes/rpc/tool-child/module-job-worker.js");
		expect(
			siblingWorkerUrl("./module-job-worker.ts", "file:///pkg/src/modes/rpc/tool-child/module-job.ts").href,
		).toBe("file:///pkg/src/modes/rpc/tool-child/module-job-worker.ts");
	});
});
