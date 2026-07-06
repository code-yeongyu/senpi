import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import senpiCodemode from "../src/index.ts";

describe("senpi-codemode extension factory", () => {
	it("registers eval during factory setup", () => {
		const registeredTools: string[] = [];
		const events: string[] = [];
		const pi = {
			registerTool(tool: { readonly name: string }) {
				registeredTools.push(tool.name);
			},
			on(event: string) {
				events.push(event);
			},
		} as unknown as ExtensionAPI;

		expect(() => senpiCodemode(pi)).not.toThrow();
		expect(registeredTools).toEqual(["eval"]);
		expect(events).toEqual(["session_start", "session_shutdown", "session_before_switch", "session_before_fork"]);
	});
});
