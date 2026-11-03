import { isAbsolute } from "node:path";
import type { AgentToolResult, HandScope, OpenHandScope } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "../../core/extensions/types.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { grantLooplessExecuteToRemoteExecutor } from "./loopless-execute-grant.ts";
import { createLooplessRuntimeFactory } from "./runtime-factory-loopless.ts";

function notFound(name: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: `Tool ${name} not found` }], details: {}, isError: true };
}

/**
 * Opens a hand's execution scopes on loopless runtimes (brain/hand split, S27a): one runtime per scope, bound to the
 * scope's root as its cwd, built with the remote tool executor's grant so every call runs that runtime's extensions'
 * `tool_call`/`tool_result` handlers (permission checks among them) around the tool. Nothing about the session reaches
 * the runtime: the scope ID and root are all it is opened with.
 */
export function createLooplessHandScopes(
	configuration: CliRuntimeConfiguration,
	local: { extensionFactories?: InlineExtension[]; startupSettingsManager?: SettingsManager } = {},
): OpenHandScope {
	const factory = createLooplessRuntimeFactory(configuration, {
		...local,
		executeGrant: grantLooplessExecuteToRemoteExecutor(),
	});
	return async (scope): Promise<HandScope> => {
		if (!isAbsolute(scope.root))
			throw new Error(`scope root must be an absolute path: ${JSON.stringify(scope.root)}`);
		const runtime = await factory({ cwd: scope.root });
		return {
			run: (call) =>
				runtime.definitions.has(call.name)
					? runtime.execute(call.name, call.toolCallId, call.arguments, call.signal)
					: Promise.resolve(notFound(call.name)),
			isSequential: (name) => runtime.definitions.get(name)?.definition.executionMode === "sequential",
			dispose: () => runtime.dispose(),
		};
	};
}
