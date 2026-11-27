import { describe, expect, it } from "vitest";
import { queuedWaitDetachClause, queuedWaitPhrase } from "../src/tool/queued-wait.ts";

describe("queued-cell wait wording has one definition", () => {
	it.each([undefined, "workspace" as const])(
		"opens the detach clause with the same phrase the list and the live update use (waitingFor: %s)",
		(waitingFor) => {
			expect(queuedWaitDetachClause("js", waitingFor).startsWith(`${queuedWaitPhrase("js", waitingFor)}; `)).toBe(
				true,
			);
		},
	);

	it("keeps the kernel-start wording of the detach answer", () => {
		expect(queuedWaitDetachClause("py", undefined)).toBe(
			"waiting for the py kernel to be ready; it runs first once the kernel is ready",
		);
	});
});
