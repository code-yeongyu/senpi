import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import type { KernelToolDescriptor, KernelToolsInvokeOptions } from "../src/kernels/js/kernel-tools-types.ts";

class QaFailure extends Error {
	readonly name = "QaFailure";
}

/** The parent cell registers the closures a child would be granted, then parks on a host tool. */
const PARENT_CELL = [
	"tool(async function fetch_path(path) { return await tool.read({ path }); });",
	"tool(async function store_path(path) { return await tool.write({ path, content: 'body' }); });",
	"await tool.hold({});",
	"return 'parent-done';",
].join("\n");

function settled(error: unknown): { readonly code: string; readonly details: unknown } {
	if (!(error instanceof Error)) return { code: "unknown", details: undefined };
	return {
		code: "code" in error ? String(error.code) : "unknown",
		details: "details" in error ? error.details : undefined,
	};
}

async function main(): Promise<void> {
	const hostToolCalls: string[] = [];
	const kernel = new JavaScriptKernel({
		sessionId: "qa-kernel-tool-scope",
		cwd: process.cwd(),
		parallelPoolWidth: 2,
		onMessage: (message: KernelToHostMessage) => {
			if (message.type === "tool-call") hostToolCalls.push(message.toolName);
		},
	});
	try {
		const parent = kernel.run({ cellId: "qa-scope-parent", code: PARENT_CELL, timeoutMs: 30_000 });
		const hold = await kernel.nextToolCall();
		if (hold.toolName !== "hold") throw new QaFailure(`parent cell parked on ${hold.toolName}`);
		const described = await kernel.describeKernelTools(["fetch_path", "store_path"]);
		const descriptors = new Map<string, KernelToolDescriptor>();
		for (const entry of described.results) {
			if (!entry.ok) throw new QaFailure(`kernel tool descriptor missing: ${entry.name}`);
			descriptors.set(entry.name, entry.descriptor);
		}
		const invoke = (name: string, callId: string, options: KernelToolsInvokeOptions): Promise<unknown> => {
			const descriptor = descriptors.get(name);
			if (!descriptor) throw new QaFailure(`kernel tool descriptor missing: ${name}`);
			return kernel.invokeKernelTool(
				{
					name: descriptor.name,
					kernel_generation: descriptor.kernel_generation,
					definition_revision: descriptor.definition_revision,
					args: { path: "demo.txt" },
					call_id: callId,
				},
				options,
			);
		};

		const denied = await invoke("store_path", "qa-denied", { scope: { tools: { deny: ["write"] } } }).then(
			(value) => ({ settled: "resolved", value }),
			(error: unknown) => ({ settled: "rejected", ...settled(error) }),
		);
		console.log(`DENIED=${JSON.stringify(denied)}`);

		const allowed = invoke("fetch_path", "qa-allowed", { scope: { tools: { allow: ["read"], deny: ["write"] } } });
		const readCall = await kernel.nextToolCall();
		if (readCall.toolName !== "read") throw new QaFailure(`allowed nested call reached ${readCall.toolName}`);
		kernel.deliverToolReply({ type: "tool-reply", callId: readCall.callId, ok: true, value: "nested-body" });
		console.log(`ALLOWED=${JSON.stringify(await allowed)}`);

		kernel.deliverToolReply({ type: "tool-reply", callId: hold.callId, ok: true, value: "held" });
		const parentResult = await parent;
		console.log(`PARENT=${JSON.stringify({ ok: parentResult.ok, valueRepr: parentResult.valueRepr })}`);
		console.log(`HOST_TOOL_CALLS=${JSON.stringify(hostToolCalls)}`);

		if (denied.settled !== "rejected" || denied.code !== "kernel_tool_host_denied") {
			throw new QaFailure("denied nested host call did not fail closed");
		}
		if (JSON.stringify(denied.details) !== JSON.stringify({ tool: "write", call_id: "qa-denied", reason: "deny" })) {
			throw new QaFailure("refusal payload did not name the tool, call and reason");
		}
		if (JSON.stringify(hostToolCalls) !== JSON.stringify(["hold", "read"])) {
			throw new QaFailure(`denied nested call reached the host bridge: ${hostToolCalls.join(",")}`);
		}
		if (!parentResult.ok) throw new QaFailure("parent cell did not survive the refusal");
		console.log("\nQA PASS — scoped invoke refused write on its own channel, allowed read, parent cell unaffected");
	} finally {
		await kernel.close();
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
