import { afterEach, describe, expect, it } from "vitest";
import { ClientAdmissions } from "../../src/modes/rpc/client-admissions.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("abortedBy forgetting (senpi#3156)", () => {
	it("forgets only the abort that settled, never a newer one recorded meanwhile", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [] });
		harnesses.push(harness);
		const admissions = ClientAdmissions.forSession(harness.session);
		await admissions.ready;

		const first = admissions.noteAbort({ connectionId: "socket-1" }, "first");
		admissions.noteAbort({ connectionId: "socket-2" }, "second");
		admissions.forgetAbort(first);

		expect(admissions.abortedBy).toEqual({ connectionId: "socket-2", effectId: "second" });
	});

	it("forgets the settled abort when nothing newer was recorded", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [] });
		harnesses.push(harness);
		const admissions = ClientAdmissions.forSession(harness.session);
		await admissions.ready;

		const only = admissions.noteAbort({ connectionId: "socket-1" }, "only");
		admissions.forgetAbort(only);

		expect(admissions.abortedBy).toBeUndefined();
	});
});
