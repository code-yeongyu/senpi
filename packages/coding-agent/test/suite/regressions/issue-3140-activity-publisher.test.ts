import { describe, expect, it, vi } from "vitest";
import { createUserActivitySource, emitUserActivity } from "../../../src/core/extensions/user-activity.ts";

describe("borrowed receiver activity publisher (#3140)", () => {
	it.each([undefined, {}])("ignores a session without the publisher: %s", (session) => {
		expect(() => emitUserActivity(session, "draft")).not.toThrow();
	});

	it("still forwards activity to the owning source", () => {
		const source = createUserActivitySource();
		const observed = vi.fn();
		source.subscribe(observed);

		emitUserActivity({ recordUserActivity: source.emit }, "draft");

		expect(observed).toHaveBeenCalledExactlyOnceWith("draft");
	});
});
