import { describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	buildRpcCommands,
	createCommandsChangedEvent,
	rpcCommandListDigest,
} from "../src/modes/rpc/rpc-command-surface.ts";

const sourceInfo = createSyntheticSourceInfo("rpc-commands-changed-test", { source: "test" });

describe("RPC command surface updates", () => {
	it("publishes only post-baseline command surface changes", () => {
		const commands = buildRpcCommands({
			extensionCommands: [{ name: "hooks", description: "Manage hooks", sourceInfo }],
			promptTemplates: [{ name: "review", description: "Review work", sourceInfo }],
			skills: [{ name: "debugging", description: "Debug runtime failures", sourceInfo }],
		});

		expect(commands.map(({ name, source, syntax }) => ({ name, source, syntax }))).toEqual([
			{ name: "hooks", source: "extension", syntax: "slash" },
			{ name: "review", source: "prompt", syntax: "slash" },
			{ name: "skill:debugging", source: "skill", syntax: "dollar" },
		]);

		expect(createCommandsChangedEvent(undefined, commands)).toBeUndefined();
		expect(createCommandsChangedEvent(rpcCommandListDigest(commands), commands)).toBeUndefined();

		const changedCommands = buildRpcCommands({
			extensionCommands: [
				{ name: "hooks", description: "Manage hooks", sourceInfo },
				{ name: "reload", description: "Reload extensions", sourceInfo },
			],
			promptTemplates: [{ name: "review", description: "Review work", sourceInfo }],
			skills: [{ name: "debugging", description: "Debug runtime failures", sourceInfo }],
		});
		expect(createCommandsChangedEvent(rpcCommandListDigest(commands), changedCommands)).toEqual({
			type: "commands_changed",
			commands: changedCommands,
		});
	});
});
