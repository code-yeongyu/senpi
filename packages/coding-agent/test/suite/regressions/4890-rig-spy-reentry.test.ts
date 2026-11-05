import { afterEach, describe, expect, test } from "vitest";
import { cleanupHostSessionRigs, rig } from "../host-session-support.ts";

afterEach(cleanupHostSessionRigs);

describe("a rig whose previous spy was never restored still launches a host (senpi#4890)", () => {
	test("a second rig before cleanup opens its session instead of overflowing the stack", async () => {
		// Given: one rig whose ensureHost spy is still installed, as after a cleanup hook that timed out
		await rig();

		// When
		const second = await rig();

		// Then
		expect(second.opened.exitCode).toBe(0);
	});
});
