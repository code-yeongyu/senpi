import { describe, expect, it } from "vitest";
import { hostDeniedError, hostToolRefusal } from "../src/kernels/js/kernel-tools-scope.js";

/** Call-scoped host-tool policy for kernel-tool invoke (https://github.com/code-yeongyu/senpi/issues/1731). */
describe("kernel-tool call scope policy", () => {
	it("permits every host tool when the call carries no tool scope", () => {
		expect(hostToolRefusal(undefined, "write")).toBeNull();
		expect(hostToolRefusal({}, "write")).toBeNull();
		expect(hostToolRefusal({ tools: {} }, "write")).toBeNull();
	});

	it("refuses only the denied host tools", () => {
		const scope = { tools: { deny: ["write"] } };
		expect(hostToolRefusal(scope, "write")).toBe("deny");
		expect(hostToolRefusal(scope, "read")).toBeNull();
	});

	it("refuses every host tool outside the allow list, including an empty allow list", () => {
		expect(hostToolRefusal({ tools: { allow: ["read"] } }, "read")).toBeNull();
		expect(hostToolRefusal({ tools: { allow: ["read"] } }, "write")).toBe("allow");
		expect(hostToolRefusal({ tools: { allow: [] } }, "read")).toBe("allow");
	});

	it("lets deny win over allow for the same host tool", () => {
		const scope = { tools: { allow: ["read", "write"], deny: ["write"] } };
		expect(hostToolRefusal(scope, "write")).toBe("deny");
		expect(hostToolRefusal(scope, "read")).toBeNull();
	});

	it("matches host tool names exactly", () => {
		expect(hostToolRefusal({ tools: { deny: ["write"] } }, "Write")).toBeNull();
		expect(hostToolRefusal({ tools: { allow: ["read"] } }, "Read")).toBe("allow");
	});

	it("fails closed on a malformed list instead of widening the scope", () => {
		expect(hostToolRefusal({ tools: { deny: "write" } }, "read")).toBe("deny");
		expect(hostToolRefusal({ tools: { allow: "read" } }, "read")).toBe("allow");
	});

	it("builds a typed refusal carrying the tool, the invoking call id and the reason", () => {
		const error = hostDeniedError("write", "call-7", "deny");
		expect(error.name).toBe("KernelToolError");
		expect(error.code).toBe("kernel_tool_host_denied");
		expect(error.details).toEqual({ tool: "write", call_id: "call-7", reason: "deny" });
		expect(error.message).toContain("write");
	});
});
