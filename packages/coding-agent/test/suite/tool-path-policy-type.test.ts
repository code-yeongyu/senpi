import type { FilesystemPolicyChecker, PolicyHooks } from "@code-yeongyu/senpi-machine-ops";
import { describe, expect, it } from "vitest";
import { createAllToolDefinitions, type ToolsOptions } from "../../src/core/tools/index.ts";

// senpi#5603 review: the tool path honours only PolicyHooks.beforeOp, so ToolsOptions.machinePolicy rejects the hooks
// it would ignore (filesystem, afterOp) at compile time. Each @ts-expect-error below fails `bun check` if the
// type accepts the hook again; the runtime body only keeps the declarations reachable.

const allowAll: FilesystemPolicyChecker = async () => ({ allow: true });

function typeChecks(cwd: string): ToolsOptions[] {
	const beforeOpOnly: ToolsOptions = { machinePolicy: { beforeOp: async () => ({ allow: true }) } };
	createAllToolDefinitions(cwd, beforeOpOnly);
	// @ts-expect-error filesystem is never consulted on the tool path
	const filesystem: ToolsOptions = { machinePolicy: { filesystem: allowAll } };
	// @ts-expect-error afterOp is never called on the tool path
	const afterOp: ToolsOptions = { machinePolicy: { afterOp: async () => {} } };
	const fullHooks: PolicyHooks = { beforeOp: async () => ({ allow: true }), filesystem: allowAll };
	// @ts-expect-error a full PolicyHooks value may carry hooks the tool path ignores
	const widened: ToolsOptions = { machinePolicy: fullHooks };
	return [beforeOpOnly, filesystem, afterOp, widened];
}

describe("ToolsOptions.machinePolicy type (senpi#5603)", () => {
	it("accepts beforeOp and rejects filesystem and afterOp at compile time", () => {
		expect(typeChecks).toBeTypeOf("function");
	});
});
