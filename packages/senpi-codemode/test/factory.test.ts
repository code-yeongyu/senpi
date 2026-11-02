import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import senpiCodemode from "../src/index.ts";

function isExtensionApi(value: unknown): value is ExtensionAPI {
	if (typeof value !== "object" || value === null) return false;
	for (const key of ["registerTool", "registerRemovedToolHint", "on"] as const) {
		if (!(key in value)) return false;
		const member: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
		if (typeof member !== "function") return false;
	}
	return true;
}

describe("senpi-codemode extension factory", () => {
	it("registers eval during factory setup", () => {
		const registeredTools: string[] = [];
		const events: string[] = [];
		const pi = {
			registerTool(tool: { readonly name: string }) {
				registeredTools.push(tool.name);
			},
			registerRemovedToolHint() {},
			on(event: string) {
				events.push(event);
			},
		};
		if (!isExtensionApi(pi)) throw new Error("the ExtensionAPI surface the factory uses changed");

		expect(() => senpiCodemode(pi)).not.toThrow();
		expect(registeredTools).toEqual(["eval"]);
		expect(events).toEqual(["resources_discover", "session_start", "session_shutdown", "model_select", "turn_start"]);
	});
});
