import { describe, expect, it } from "vitest";
import { presenterPipePath } from "../../src/modes/rpc/multi-session-host.ts";
import { hostInstanceId } from "../../src/modes/rpc/protocol-identity.ts";

// #4255 review: the presenter instance is now the public protocol instanceId, so the Windows control pipe
// must not be named after it, or a local process could squat the name before the host listens.
describe("presenter control pipe name", () => {
	it("is a fresh random name, never derived from the public host instanceId", () => {
		const first = presenterPipePath();
		const second = presenterPipePath();
		expect(first).toMatch(/^\\\\\.\\pipe\\senpi-presenter-[0-9a-f-]{36}$/);
		expect(first).not.toContain(hostInstanceId());
		expect(second).not.toBe(first);
	});
});
