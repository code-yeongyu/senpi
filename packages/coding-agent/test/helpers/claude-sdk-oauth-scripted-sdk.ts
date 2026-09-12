import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
	AccountSlot,
	ClaudeSdkOauthCredential,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { addAccount, emptyCredential } from "../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/auth-lane.ts";
import type {
	SDKMessage,
	SDKUserMessage,
	SdkQuery,
	SdkQueryHandle,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";

export const SCRIPTED_PROVIDER = "claude-sdk-oauth";

export function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

export function streamEvent(sessionId: string, event: unknown): SDKMessage {
	return sdkMessage({ type: "stream_event", event, session_id: sessionId, parent_tool_use_id: null, uuid: "evt" });
}

export type TurnScript = (sessionId: string, userUuid: string, submission: number) => SDKMessage[];

/** Resident SDK stand-in: echoes each submission as a replay, then plays the scripted turn. */
export class ScriptedResidentQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	readonly submitted: SDKUserMessage[] = [];
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	constructor(prompt: AsyncIterable<SDKUserMessage>, script: TurnScript) {
		void this.consume(prompt, script);
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		return value ? Promise.resolve({ value, done: false }) : new Promise((resolve) => this.readers.push(resolve));
	}

	async interrupt(): Promise<unknown> {
		return { still_queued: [] };
	}

	close(): void {
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	private async consume(prompt: AsyncIterable<SDKUserMessage>, script: TurnScript): Promise<void> {
		for await (const message of prompt) {
			this.submitted.push(message);
			const uuid = message.uuid ?? `submitted-${this.submitted.length}`;
			this.emit(sdkMessage({ ...message, uuid, isReplay: true }));
			const sessionId = message.session_id ?? "scripted-session";
			for (const scripted of script(sessionId, uuid, this.submitted.length)) this.emit(scripted);
		}
	}
}

export function installScriptedSdk(script: TurnScript): ScriptedResidentQuery[] {
	const queries: ScriptedResidentQuery[] = [];
	const query: SdkQuery = ({ prompt }) => {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		const handle = new ScriptedResidentQuery(prompt, script);
		queries.push(handle);
		return handle;
	};
	overrideSdkBoundary({ query, createSdkMcpServer: (() => ({ type: "sdk", name: "senpi" })) as never });
	overrideSessionRegistryBoundary({ queryFactory: query });
	return queries;
}

const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;
const originalExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
const temporaryDirectories: string[] = [];

/** One pinned oauth-slots account whose settings file selects the managed lane. */
export async function installSingleAccountLane(): Promise<void> {
	const slot: AccountSlot = {
		name: "primary",
		access: "access-primary",
		refresh: "r",
		expires: Date.now() + 3_600_000,
		source: "login",
	};
	const store = new InMemoryCredentialStore();
	await store.modify(
		SCRIPTED_PROVIDER,
		async () => ({ ...addAccount(emptyCredential(), slot), pinned: slot.name }) satisfies ClaudeSdkOauthCredential,
	);
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-claude-sdk-oauth-scripted-"));
	temporaryDirectories.push(agentDir);
	process.env.SENPI_CODING_AGENT_DIR = agentDir;
	process.env.CLAUDE_CODE_EXECUTABLE = "/bin/true";
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "oauth-slots" } }),
	);
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({ PATH: "/usr/bin" }),
		getAgentDir: () => agentDir,
	});
}

export function resetScriptedSdk(): void {
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	if (originalExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
	else process.env.CLAUDE_CODE_EXECUTABLE = originalExecutable;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
}
