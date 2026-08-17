import type { SourceInfo } from "../../core/source-info.ts";

export type RpcCommandSource = "extension" | "prompt" | "skill";

export interface RpcSlashCommand {
	/** Command name without its leading invocation marker. */
	name: string;
	/** Human-readable description. */
	description?: string;
	/** What kind of command this is. */
	source: RpcCommandSource;
	/** Source metadata for the owning resource. */
	sourceInfo: SourceInfo;
	/** Canonical marker clients should insert for this candidate. */
	syntax: "slash" | "dollar";
}

export interface RpcCommandsChangedEvent {
	type: "commands_changed";
	commands: readonly RpcSlashCommand[];
}

interface RpcCommandInput {
	name: string;
	description?: string;
	sourceInfo: SourceInfo;
}

interface RpcCommandSurfaceInput {
	extensionCommands: readonly RpcCommandInput[];
	promptTemplates: readonly RpcCommandInput[];
	skills: readonly RpcCommandInput[];
}

interface RpcCommandSurfaceSession {
	extensionRunner: {
		getRegisteredCommands(): readonly {
			invocationName: string;
			description?: string;
			sourceInfo: SourceInfo;
		}[];
	};
	promptTemplates: readonly RpcCommandInput[];
	resourceLoader: {
		getSkills(): {
			skills: readonly RpcCommandInput[];
		};
	};
}

export function buildRpcCommands(input: RpcCommandSurfaceInput): RpcSlashCommand[] {
	return [
		...input.extensionCommands.map((command) => ({
			...command,
			source: "extension" as const,
			syntax: "slash" as const,
		})),
		...input.promptTemplates.map((template) => ({
			...template,
			source: "prompt" as const,
			syntax: "slash" as const,
		})),
		...input.skills.map((skill) => ({
			...skill,
			name: `skill:${skill.name}`,
			source: "skill" as const,
			syntax: "dollar" as const,
		})),
	];
}

export function buildRpcCommandsForSession(session: RpcCommandSurfaceSession): RpcSlashCommand[] {
	return buildRpcCommands({
		extensionCommands: session.extensionRunner.getRegisteredCommands().map((command) => ({
			name: command.invocationName,
			description: command.description,
			sourceInfo: command.sourceInfo,
		})),
		promptTemplates: session.promptTemplates,
		skills: session.resourceLoader.getSkills().skills,
	});
}

export function rpcCommandListDigest(commands: readonly RpcSlashCommand[]): string {
	return JSON.stringify(commands);
}

export function createCommandsChangedEvent(
	previousDigest: string | undefined,
	commands: readonly RpcSlashCommand[],
): RpcCommandsChangedEvent | undefined {
	if (previousDigest === undefined || previousDigest === rpcCommandListDigest(commands)) return undefined;
	return { type: "commands_changed", commands };
}
