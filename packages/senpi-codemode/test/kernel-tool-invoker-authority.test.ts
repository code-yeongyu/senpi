import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { createExtensionRuntime } from "../../coding-agent/src/core/extensions/loader.ts";
import { kernelToolsStorage } from "../../coding-agent/src/core/extensions/kernel-tools-context.ts";
import { ExtensionRunner } from "../../coding-agent/src/core/extensions/runner.ts";
import { ModelRegistry } from "../../coding-agent/src/core/model-registry.ts";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { InProcessToolDispatcher } from "../../coding-agent/src/core/tool-dispatch/tool-dispatcher.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

// #4309: the real dispatcher and worker boundary own invoker identity, not cell arguments.
describe.each(["worker", "inline"] as const)("kernel-tool invoker authority (%s)", (mode) => {
	it.each([
		{ ownerActive: true, invokerActive: false, same: true, denied: false },
		{ ownerActive: true, invokerActive: false, same: false, denied: true },
		{ ownerActive: false, invokerActive: true, same: false, denied: true },
		{ ownerActive: false, invokerActive: false, same: false, denied: false },
	])("decides before the body runs: %j", async ({ ownerActive, invokerActive, same, denied }) => {
		const owner = SessionManager.inMemory();
		const caller = same ? owner : SessionManager.inMemory();
		const rule = { permission: "bash", pattern: "uname", layer: "user" };
		const options = (sessionId: string, active: boolean) => ({
			sessionId,
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			...(mode === "inline" ? { workerEntryUrl: pathToFileURL("/missing-invoker-worker.js") } : {}),
			permissions: {
				state: () => ({ active, epoch: 1, rules: active ? [rule] : [] }),
				decide: () => ({ action: "pass" as const }),
			},
		});
		const kernel = new JavaScriptKernel(options(owner.getSessionId(), ownerActive));
		const invokingKernel = same ? undefined : new JavaScriptKernel(options(caller.getSessionId(), invokerActive));
		const runner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			caller,
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		const ownerRunner = new ExtensionRunner(
			[],
			createExtensionRuntime(),
			process.cwd(),
			owner,
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		try {
			expect(
				await kernel.run({
					cellId: "define",
					code: `let calls = 0; tool(function probe(invoker) { calls++; return invoker; });`,
				}),
			).toMatchObject({ ok: true });
			const entry = (await kernel.describeKernelTools(["probe"])).results[0];
			if (!entry?.ok) throw new Error("missing probe descriptor");
			const capability = {
				capabilities: { invokeScope: true },
				describe: kernel.describeKernelTools.bind(kernel),
				invoke: kernel.invokeKernelTool.bind(kernel),
			};
			const invoke = () =>
				kernelToolsStorage.run(capability, async () => {
					// A task grants a capability captured in the parent, not one created by the child.
					const tools = ownerRunner.createContext().kernelTools;
					if (!tools) throw new Error("missing dispatcher capability");
					const dispatched = await new InProcessToolDispatcher().run({
						toolCallId: "child-granted-tool",
						params: {},
						ctx: runner.createToolContext("child-granted-tool", undefined),
						definition: {
							name: "granted",
							label: "Granted",
							description: "Invoke the parent's granted kernel closure",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [],
								details: await tools.invoke(
									{
										...entry.descriptor,
										args: { invoker: { sessionId: owner.getSessionId() } },
										call_id: crypto.randomUUID(),
									},
									{ invoker: { sessionId: owner.getSessionId() } },
								),
							}),
						},
					});
					return dispatched.details;
				});
			if (denied) {
				await expect(invoke()).rejects.toMatchObject({
					code: "cell_permission_denied",
					rule,
					message: expect.stringContaining(rule.pattern),
				});
			} else {
				expect(await invoke()).toEqual({ sessionId: owner.getSessionId() });
			}
			expect(await kernel.run({ cellId: "count", code: "return calls;" })).toMatchObject({
				ok: true,
				valueRepr: denied ? "0" : "1",
			});
		} finally {
			await kernel.close();
			await invokingKernel?.close();
		}
	});
});
