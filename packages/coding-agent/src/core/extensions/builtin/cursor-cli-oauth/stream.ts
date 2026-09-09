import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type CredentialStore,
	calculateCost,
	createAssistantMessageDiagnostic,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import { estimateTokens } from "../../../compaction/compaction.ts";
import { type CursorCliAccountSlot, type CursorCliOauthCredential, emptyCredential, listAccounts } from "./accounts.ts";
import { DEFAULT_CURSOR_AFFINITY_KEY } from "./affinity.ts";
import {
	type CursorAgentExecutableDeps,
	defaultCursorAgentExecutableDeps,
	resolveCursorAgentExecutable,
} from "./executable.ts";
import { type CursorCliAttemptOptions, type CursorCliFailoverNotice, runCursorCliFailover } from "./failover.ts";
import {
	applyCursorCliDenyConfig,
	CursorCliExecutionRefusalError,
	createCursorCliGuardrailSession,
	resolveCursorCliExecutionPolicy,
} from "./guardrails.ts";
import { runInCursorAccountHome } from "./home-store.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	type CursorCliOauthConfig,
	createCursorCliOauthConfig,
	cursorAgentNotInstalledError,
	isCursorCliOauthLaneEnabled,
} from "./oauth-login.ts";
import {
	type CursorCliRecapExchange,
	type CursorCliSessionRestartNotice,
	type CursorCliSessionRouter,
	type CursorCliSessionTurnInput,
	cursorCliSessionRouter,
} from "./session-router.ts";
import { type CursorCliOauthProviderSettings, loadCursorCliOauthProviderSettingsFromDisk } from "./settings.ts";
import { resolveCursorCliSpawnModel } from "./spawn-model.ts";
import type { CursorCliStreamEvent } from "./stream-parser.ts";
import { CursorCliAbortError, type CursorCliTransportHandle, spawnCursorCli } from "./transport.ts";

export { CURSOR_CLI_OAUTH_PROVIDER_ID } from "./oauth-login.ts";

const DISABLED_MESSAGE = "disabled by settings";
const NO_ACCOUNTS_MESSAGE = "no accounts: run /login cursor-cli-oauth";
const RECENT_EXCHANGE_LIMIT = 12;

/** Injectable seams so tests stay hermetic; every default is re-resolved per turn. */
export type CursorCliStreamDeps = {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly store?: CredentialStore;
	readonly settings?: CursorCliOauthProviderSettings;
	readonly router?: CursorCliSessionRouter;
	readonly oauth?: Pick<CursorCliOauthConfig, "refreshToken">;
	readonly now?: () => number;
	/** Credential-home log line sink; receives byte lengths only, never token material. */
	readonly log?: (line: string) => void;
	readonly executableDeps?: CursorAgentExecutableDeps;
};

/**
 * A non-zero cursor-agent exit that produced no result event. Carries the
 * captured stderr so `classifyCursorCliError` can match the real cause instead
 * of the generic "no assistant text" wrapper.
 */
class CursorCliProcessFailureError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(exitCode: number | null, stderr: string) {
		super(stderr.trim().length > 0 ? stderr.trim() : `cursor-agent exited with code ${String(exitCode)}`);
		this.name = "CursorCliProcessFailureError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

/** Minimal async queue bridging the home-store-wrapped transport run into a pullable iterable. */
class CursorCliEventBuffer<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(error?: unknown) => void> = [];
	private ended = false;
	private failure: unknown;
	private settled = false;

	private wake(error?: unknown): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(error);
	}

	push(value: T): void {
		if (this.ended || this.failure !== undefined) return;
		this.values.push(value);
		this.wake();
	}

	close(): void {
		if (this.settled) return;
		this.settled = true;
		this.ended = true;
		for (const waiter of this.waiters.splice(0)) waiter();
	}

	fail(error: unknown): void {
		if (this.settled) return;
		this.settled = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter(error);
	}

	async *events(): AsyncGenerator<T, void, unknown> {
		while (true) {
			const value = this.values.shift();
			if (value !== undefined) {
				yield value;
				continue;
			}
			if (this.failure !== undefined) throw this.failure;
			if (this.ended) return;
			await new Promise<void>((resolve, reject) => {
				this.waiters.push((error?: unknown) => {
					if (error !== undefined) reject(error);
					else resolve();
				});
			});
		}
	}
}

type OpenBlockKind = "text" | "thinking" | "tool";

type StreamMapper = {
	readonly stream: AssistantMessageEventStream;
	readonly output: AssistantMessage;
	started: boolean;
	openKind: OpenBlockKind | undefined;
	openIndex: number;
	openText: string;
	/** Assistant text seen so far in the open text block, for cumulative-snapshot detection. */
	textAccumulated: string;
};

function emptyCursorCliOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function ensureStarted(mapper: StreamMapper): void {
	if (mapper.started) return;
	mapper.started = true;
	mapper.stream.push({ type: "start", partial: mapper.output });
}

function openBlock(mapper: StreamMapper, kind: OpenBlockKind): void {
	ensureStarted(mapper);
	if (kind === "thinking") {
		mapper.output.content.push({ type: "thinking", thinking: "" });
	} else {
		mapper.output.content.push({ type: "text", text: "" });
	}
	mapper.openKind = kind;
	mapper.openIndex = mapper.output.content.length - 1;
	mapper.openText = "";
	mapper.textAccumulated = "";
	mapper.stream.push({
		type: kind === "thinking" ? "thinking_start" : "text_start",
		contentIndex: mapper.openIndex,
		partial: mapper.output,
	});
}

function closeOpen(mapper: StreamMapper): void {
	if (mapper.openKind === undefined) return;
	const block = mapper.output.content[mapper.openIndex];
	if (mapper.openKind === "thinking") {
		if (block !== undefined && block.type === "thinking") block.thinking = mapper.openText;
		mapper.stream.push({
			type: "thinking_end",
			contentIndex: mapper.openIndex,
			content: mapper.openText,
			partial: mapper.output,
		});
	} else {
		if (block !== undefined && block.type === "text") block.text = mapper.openText;
		mapper.stream.push({
			type: "text_end",
			contentIndex: mapper.openIndex,
			content: mapper.openText,
			partial: mapper.output,
		});
	}
	mapper.openKind = undefined;
}

function ensureOpen(mapper: StreamMapper, kind: OpenBlockKind): void {
	if (mapper.openKind === kind) return;
	closeOpen(mapper);
	openBlock(mapper, kind);
}

function resetTextSegment(mapper: StreamMapper): void {
	closeOpen(mapper);
	mapper.textAccumulated = "";
}

function pushTextDelta(mapper: StreamMapper, delta: string): void {
	const block = mapper.output.content[mapper.openIndex];
	mapper.openText += delta;
	if (block !== undefined && block.type === "text") block.text = mapper.openText;
	mapper.stream.push({ type: "text_delta", contentIndex: mapper.openIndex, delta, partial: mapper.output });
}

function pushThinkingDelta(mapper: StreamMapper, delta: string): void {
	const block = mapper.output.content[mapper.openIndex];
	mapper.openText += delta;
	if (block !== undefined && block.type === "thinking") block.thinking = mapper.openText;
	mapper.stream.push({
		type: "thinking_delta",
		contentIndex: mapper.openIndex,
		delta,
		partial: mapper.output,
	});
}

/**
 * Appends one assistant fragment as a text delta. The CLI streams partial
 * output deltas and then repeats the full message in a final frame, so a
 * fragment that already starts with the accumulated text is the cumulative
 * snapshot: replace instead of appending so the answer is never duplicated.
 */
function appendAssistantFragment(mapper: StreamMapper, fragment: string): void {
	if (fragment.length === 0) return;
	ensureOpen(mapper, "text");
	let delta: string;
	if (
		fragment.length >= mapper.textAccumulated.length &&
		(mapper.textAccumulated.length === 0 || fragment.startsWith(mapper.textAccumulated))
	) {
		delta = fragment.slice(mapper.textAccumulated.length);
		mapper.textAccumulated = fragment;
	} else {
		delta = fragment;
		mapper.textAccumulated += fragment;
	}
	if (delta.length > 0) pushTextDelta(mapper, delta);
}

function appendNotice(mapper: StreamMapper, message: string): void {
	ensureOpen(mapper, "text");
	pushTextDelta(mapper, `${message}\n`);
}

/**
 * Records the result event: senpi's own token estimate of the payload it sent,
 * the CLI's output tokens, and the CLI's input/cache numbers quarantined in a
 * telemetry diagnostic. estimateContextTokens treats the last assistant usage
 * as the authoritative context base, so CLI-side context numbers must never
 * reach `usage` or senpi would demand a compaction only the CLI could perform.
 */
function applyResultEvent(
	mapper: StreamMapper,
	model: Model<Api>,
	sentPromptTokens: number,
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	},
	requestId: string,
	durationMs: number,
): void {
	const output = mapper.output;
	output.usage.input = sentPromptTokens;
	output.usage.output = usage.outputTokens;
	output.usage.cacheRead = 0;
	output.usage.cacheWrite = 0;
	output.usage.totalTokens = 0;
	output.usage.cost = calculateCost(model, output.usage);
	output.stopReason = "stop";
	output.diagnostics = [
		...(output.diagnostics ?? []),
		createAssistantMessageDiagnostic(
			"cursor_cli_oauth_cli_usage",
			"cursor-agent reported usage (telemetry only; never used for senpi context accounting)",
			{
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheWriteTokens: usage.cacheWriteTokens,
				requestId,
				durationMs,
			},
		),
	];
}

function blockText(blocks: readonly unknown[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.length > 0) {
			parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

function lastUserPrompt(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message === undefined || message.role !== "user") continue;
		return typeof message.content === "string" ? message.content : blockText(message.content);
	}
	throw new Error("cursor-cli-oauth needs a user message to prompt the Cursor CLI");
}

function recapExchanges(context: Context): CursorCliRecapExchange[] {
	const exchanges: CursorCliRecapExchange[] = [];
	for (const message of context.messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : blockText(message.content);
			if (text.length > 0) exchanges.push({ role: "user", text });
		} else if (message.role === "assistant") {
			const text = blockText(message.content);
			if (text.length > 0) exchanges.push({ role: "assistant", text });
		}
	}
	return exchanges.slice(-RECENT_EXCHANGE_LIMIT);
}

function isFailoverNotice(event: unknown): event is CursorCliFailoverNotice {
	return (event as { type?: unknown }).type === "cursor_account_changed";
}

function isRestartNotice(event: unknown): event is CursorCliSessionRestartNotice {
	return (event as { type?: unknown }).type === "cursor_chat_restarted";
}

function turnErrorMessage(error: unknown): string {
	// Failover wraps every surfaced failure and the router hands classification
	// inputs around as { thrown } records; the innermost cause is what the user needs.
	let detail = error;
	for (let depth = 0; depth < 3 && typeof detail === "object" && detail !== null; depth += 1) {
		const wrapper = detail as { original?: unknown; thrown?: unknown };
		if (wrapper.original !== undefined) detail = wrapper.original;
		else if (wrapper.thrown !== undefined) detail = wrapper.thrown;
		else break;
	}
	if (detail instanceof Error) return detail.message;
	if (typeof detail === "string") return detail;
	const message = (detail as { message?: unknown } | null)?.message;
	return typeof message === "string" && message.length > 0 ? message : "Cursor CLI turn failed";
}

/**
 * Streams one Cursor CLI print-mode turn onto senpi's assistant event stream.
 * The CLI owns tool execution; senpi owns the context and reports only its own
 * token estimates, so no CLI-side number ever feeds compaction accounting.
 */
export function streamCursorCliOauth(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	deps: CursorCliStreamDeps = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		const mapper: StreamMapper = {
			stream,
			output: emptyCursorCliOutput(model),
			started: false,
			openKind: undefined,
			openIndex: -1,
			openText: "",
			textAccumulated: "",
		};
		const now = deps.now ?? Date.now;
		const cwdDirectory = deps.cwd ?? process.cwd();
		const agentDir = deps.agentDir ?? getAgentDir();
		const store = deps.store ?? AuthStorage.create();
		const router = deps.router ?? cursorCliSessionRouter;
		const signal = options?.signal;
		let wasAborted = signal?.aborted === true;
		let sentPromptTokens = 0;
		let runningHandle: CursorCliTransportHandle | undefined;
		let handleRunning = false;
		const onAbort = (): void => {
			wasAborted = true;
		};
		if (!wasAborted) signal?.addEventListener("abort", onAbort, { once: true });

		try {
			// Fresh per turn: settings, credentials, and executable resolution are
			// never cached across turns, so back-to-back turns observe changes.
			const settings = deps.settings ?? loadCursorCliOauthProviderSettingsFromDisk(cwdDirectory);
			// An explicit `enabled: false` is the kill switch; the flagless ambient
			// case is refused below, once the stored slots are known, so the turn path
			// and `assessConfiguration` share one opt-in rule.
			if (settings.explicitlyDisabled) throw new Error(DISABLED_MESSAGE);
			const executableDeps: CursorAgentExecutableDeps = {
				...defaultCursorAgentExecutableDeps(),
				settings: { executablePath: settings.executablePath },
			};
			// The executable gates the TURN before any guardrail or auth work: the
			// oauth check keeps a credential-backed lane selectable so turns reach
			// this point, and `cursor-agent not installed` + the install guidance
			// must originate here - before a spawn could report it without the marker.
			try {
				resolveCursorAgentExecutable(deps.executableDeps ?? executableDeps);
			} catch (error) {
				throw cursorAgentNotInstalledError(error);
			}
			// Guardrails decide before any spawn: an unacknowledged force attempt is
			// the turn's error outcome, and only the policy's force/plan/sandbox
			// verdict reaches the argv. Warnings surface as turn notices.
			const guardrailSession = createCursorCliGuardrailSession();
			const policy = resolveCursorCliExecutionPolicy(
				{
					forceExecution: settings.forceExecution,
					noApprovalAcknowledgedAt: settings.noApprovalAcknowledgedAt,
					executionMode: settings.executionMode,
					sandboxMode: settings.sandboxMode,
				},
				guardrailSession,
				settings.denyCommands ?? [],
			);
			if (policy.status === "refused") throw new CursorCliExecutionRefusalError(policy.refusal);
			for (const warning of policy.warnings) appendNotice(mapper, warning.message);
			const stored = await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID);
			const storedAccounts = stored?.type === "oauth" ? listAccounts(stored as CursorCliOauthCredential) : [];
			if (!isCursorCliOauthLaneEnabled(settings, storedAccounts.length)) throw new Error(DISABLED_MESSAGE);
			if (storedAccounts.length === 0) throw new Error(NO_ACCOUNTS_MESSAGE);

			const prompt = lastUserPrompt(context);
			const senpiSessionId = options?.affinitySessionId ?? options?.sessionId ?? DEFAULT_CURSOR_AFFINITY_KEY;
			const spawnModel = resolveCursorCliSpawnModel(model as Model<"cursor-agent">, options?.thinkingSelection);
			const turnInput: CursorCliSessionTurnInput = {
				prompt,
				model: spawnModel,
				recentExchanges: recapExchanges(context),
			};

			const spawnAndStream = (
				attempt: { prompt: string; resumeChatId: string | undefined },
				slot: CursorCliAccountSlot,
			): AsyncIterable<CursorCliStreamEvent> => {
				sentPromptTokens = estimateTokens({
					role: "user",
					content: attempt.prompt,
					timestamp: now(),
				} satisfies AgentMessage);
				const buffer = new CursorCliEventBuffer<CursorCliStreamEvent>();
				void (async () => {
					let sawResult = false;
					// Malformed events are held until the exit outcome is known: a
					// non-zero exit without a result means the captured stderr is the
					// real cause, and the parser's trailing incomplete_stream event
					// would otherwise mask it.
					const heldMalformed: CursorCliStreamEvent[] = [];
					try {
						await runInCursorAccountHome(
							agentDir,
							slot,
							async ({ home }) => {
								// The CLI rewrites cli-config.json during every invocation, so the
								// deny list must ride the same per-spawn cadence as the home-store
								// auth.json preparation directly above this spawn.
								applyCursorCliDenyConfig(home, policy.denyCommands);
								const handle = spawnCursorCli({
									prompt: attempt.prompt,
									model: spawnModel,
									resumeChatId: attempt.resumeChatId,
									force: policy.force,
									executionMode: policy.executionMode,
									sandboxMode: policy.sandboxMode,
									accountHome: home,
									cwd: cwdDirectory,
									signal,
									executableDeps: deps.executableDeps ?? executableDeps,
								});
								runningHandle = handle;
								handleRunning = true;
								if (wasAborted) handle.abort();
								try {
									for await (const event of handle.events) {
										if (event instanceof CursorCliAbortError) {
											buffer.fail(event);
											return;
										}
										if (event.type === "result") sawResult = true;
										if (event.type === "malformed_stream") {
											heldMalformed.push(event);
											continue;
										}
										buffer.push(event);
									}
									const outcome = await handle.completed;
									if (outcome.type === "completed" && outcome.exitCode !== 0 && !sawResult) {
										buffer.fail(new CursorCliProcessFailureError(outcome.exitCode, outcome.stderr));
										return;
									}
									for (const event of heldMalformed) buffer.push(event);
									buffer.close();
								} finally {
									handleRunning = false;
								}
							},
							deps.log,
						);
						buffer.close();
					} catch (error) {
						buffer.fail(error);
					}
				})();
				return buffer.events();
			};

			const turn = runCursorCliFailover<CursorCliStreamEvent | CursorCliSessionRestartNotice>({
				store,
				providerId: CURSOR_CLI_OAUTH_PROVIDER_ID,
				affinity: {
					sessionId: senpiSessionId,
					pinnedAccount: settings.pinnedAccount,
					now: now(),
				},
				now: () => now(),
				runAttempt: async (selected, _options: CursorCliAttemptOptions) => {
					let slot = selected;
					const current = await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID);
					if (current?.type === "oauth") {
						const fresh = (current as CursorCliOauthCredential).accounts?.find(
							(candidate) => candidate.name === slot.name,
						);
						if (fresh) slot = fresh;
					}
					// An expired access token would classify as auth_error and block the
					// account until re-login; refresh it while the refresh token exists.
					if (now() >= slot.expires) {
						const oauth =
							deps.oauth ??
							createCursorCliOauthConfig({
								readCurrent: () => store.read(CURSOR_CLI_OAUTH_PROVIDER_ID),
								readSettings: () => settings,
								resolveExecutable: (oauthSettings) =>
									resolveCursorAgentExecutable({
										...(deps.executableDeps ?? executableDeps),
										settings: { executablePath: oauthSettings.executablePath },
									}),
							});
						const storedCredential =
							current?.type === "oauth" ? (current as CursorCliOauthCredential) : emptyCredential();
						const refreshed = await oauth.refreshToken(storedCredential, signal ?? new AbortController().signal);
						// refreshToken re-applies the sentinel fields over the stored credential,
						// so the result keeps the persisted oauth shape.
						await store.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async () => refreshed as CursorCliOauthCredential);
						const reread = await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID);
						const updated =
							reread?.type === "oauth"
								? (reread as CursorCliOauthCredential).accounts?.find(
										(candidate) => candidate.name === slot.name,
									)
								: undefined;
						if (!updated) {
							throw new Error(`cursor-cli-oauth account '${slot.name}' disappeared during token refresh`);
						}
						slot = updated;
					}
					// Cross-account chats live in each account's HOME, so a fresh-chat
					// failover needs no flag here: the router resumes only its own account's chat.
					return router.runTurn(
						{
							senpiSessionId,
							accountName: slot.name,
							runAttempt: (attempt) => spawnAndStream(attempt, slot),
							resumeMode: settings.resumeMode,
							contextRecapOnModelSwitch: settings.contextRecapOnModelSwitch,
							now: () => now(),
						},
						turnInput,
					);
				},
			});

			for await (const event of turn) {
				if (isFailoverNotice(event) || isRestartNotice(event)) {
					appendNotice(mapper, event.message);
					continue;
				}
				switch (event.type) {
					case "system":
						// The session router already recorded chat id and model from init.
						break;
					case "thinking":
						if (event.subtype === "completed") {
							if (mapper.openKind === "thinking") closeOpen(mapper);
						} else if (event.text.length > 0) {
							ensureOpen(mapper, "thinking");
							pushThinkingDelta(mapper, event.text);
						}
						break;
					case "assistant":
						for (const block of event.message.content) appendAssistantFragment(mapper, block.text);
						break;
					case "tool_call":
						// Preserve the text-segment boundary and cumulative snapshot reset,
						// but do not expose provider protocol frames as assistant text or map
						// them to host tool calls that Senpi could execute a second time.
						resetTextSegment(mapper);
						break;
					case "result":
						if (event.subtype === "success" && !event.is_error) {
							applyResultEvent(
								mapper,
								model,
								sentPromptTokens,
								event.usage,
								event.request_id,
								event.duration_ms,
							);
						}
						break;
					default:
						// malformed_stream events are converted to failures inside the
						// session router and never reach this loop.
						break;
				}
			}

			closeOpen(mapper);
			stream.push({ type: "done", reason: "stop", message: mapper.output });
		} catch (error) {
			closeOpen(mapper);
			const aborted = wasAborted || signal?.aborted === true;
			mapper.output.stopReason = aborted ? "aborted" : "error";
			mapper.output.errorMessage = turnErrorMessage(error);
			stream.push({ type: "error", reason: mapper.output.stopReason, error: mapper.output });
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (handleRunning) runningHandle?.abort();
			stream.end();
		}
	})();
	return stream;
}
