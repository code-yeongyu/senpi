import { describe, expect, it } from "vitest";
import { shouldJoinSharedHost } from "../src/core/shared-host-policy.ts";

describe("shouldJoinSharedHost", () => {
	it("is OFF by default: a bare interactive session does not join the shared host", () => {
		expect(shouldJoinSharedHost("interactive", { enableEnv: false, settingEnabled: false })).toBe(false);
	});

	it("opts in via the ENABLE_SHARED_HOST env flag", () => {
		expect(shouldJoinSharedHost("interactive", { enableEnv: true, settingEnabled: false })).toBe(true);
	});

	it("opts in via the experimental.sharedHost setting", () => {
		expect(shouldJoinSharedHost("interactive", { enableEnv: false, settingEnabled: true })).toBe(true);
	});

	it("never joins in non-interactive modes, even when opted in", () => {
		for (const mode of ["print", "json", "rpc", "app-server"]) {
			expect(shouldJoinSharedHost(mode, { enableEnv: true, settingEnabled: true })).toBe(false);
		}
	});
});
