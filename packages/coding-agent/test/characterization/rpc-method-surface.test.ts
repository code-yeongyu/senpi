/**
 * X14 (plan row P0-03g): every RPC method the local multi-session host accepts today, with today's
 * acceptance and reply shape. Records travel over a real Unix socket into the same per-connection
 * dispatch `runSocketHost` builds (`socketSink`, `attachJsonlLineReader`, `writer.withConnection` ->
 * `createHostCore(...).handle`), on the in-process registry a `--listen` host selects, with a faux
 * provider and no network.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";

type WireRecord = Record<string, unknown>;
type Opened = { sessionId: string; state: { sessionFile: string } };

const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"];
const NO_ID = "00000000-0000-7000-8000-000000000000";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Host commands carry no `sessionId` routing envelope; every other method is routed to the fresh session. */
const HOST_METHODS = new Set(
	"get_protocol_info open_session close_session release_session unload_session detach_connection get_subscription_limits list_sessions subscribe_sessions unsubscribe_sessions set_session_context warm attach_session release_attachment reclaim_session move_session".split(
		" ",
	),
);

/**
 * Today's handler table, `[request payload JSON =>] answer`. Each method runs against a fresh session
 * (`$SID`, `$PATH`, `$NO`, `$TMP` are filled in). The answer is `ok` plus the sorted top-level `data`
 * keys, or `no:<errorCode>:<error>`. A method added to or removed from `RpcCommand` fails tsc here.
 */
const TODAY: { readonly [M in RpcCommand["type"]]: string } = {
	get_protocol_info:
		"ok{agentDir,capabilities,engineOrdinal,engineVersion,generation,instanceId,launch_profile,memory_pressure,mode,path_identity_resolver,protocolVersion,serverVersion}",
	open_session: "ok{sessionId,state}",
	close_session: '{"sessionId":"$SID"} => ok{}',
	release_session: '{"sessionId":"$SID","reason":"takeover"} => ok{attachments,dropped,released,session_path}',
	unload_session: '{"sessionId":"$SID"} => ok{outcome,sessionPath}',
	detach_connection: "ok{deferred}",
	get_subscription_limits: "ok{accounts}",
	list_sessions: "ok{sessions}",
	subscribe_sessions: "ok{hostGeneration,hostInstanceId,seq,snapshot,subscriptionId}",
	unsubscribe_sessions:
		'{"subscriptionId":"$NO"} => no:unknown_subscription:unknown_subscription: this connection holds no subscription with that id',
	set_session_context: '{"sessionId":"$SID","patch":{"lane":"x14"}} => ok{context}',
	warm: "ok{state}",
	attach_session:
		'{"sessionId":"$SID","durableSessionId":"$NO"} => no:session_identity_mismatch:session_identity_mismatch',
	release_attachment: '{"sessionId":"$SID"} => ok{deferred}',
	reclaim_session:
		'{"sessionPath":"$PATH","durableSessionId":"$NO","expectedHostInstance":"$NO"} => no:session_identity_mismatch:session_identity_mismatch',
	move_session: '{"op":"status","moveId":"$NO"} => ok{reason,state}',
	prompt: '{"message":"Hello."} => ok{disposition}',
	release_tool_barrier: '{"barrierId":"$NO"} => ok{released}',
	send_custom_message: '{"customType":"x14","content":"note","display":false} => ok',
	continue_from_leaf: "no:nothing_to_continue:There is nothing to continue: the session has no messages yet.",
	resume_session: "ok{deliveredHeldInputs,deliveredNotices,pauseSeq,reason,resumed,turnStarted}",
	append_user_message: '{"content":"Appended."} => ok',
	append_session_entry: '{"entry":{"type":"label","id":"x14","parentId":null,"timestamp":"","targetId":"$NO"}} => ok',
	steer: '{"message":"Steer."} => ok{disposition}',
	follow_up: '{"message":"Follow up."} => ok{disposition}',
	abort: "ok",
	interrupt: "ok{interrupted}",
	hold_input: '{"inputId":"$NO","revision":1,"text":"Held."} => no::hold_input_requires_interactive_client',
	withdraw_held_input: '{"inputId":"$NO"} => no::hold_input_requires_interactive_client',
	pause_for_run:
		'{"parentSessionId":"$NO","parentPauseSeq":1,"runRef":{"kind":"task","id":"$NO"}} => no::task_parent_required: only the connection that owns this task child may pause or resume it for a run',
	resume_for_run:
		'{"parentSessionId":"$NO","parentPauseSeq":1,"resumeId":"$NO","childSeqCutoff":0} => no::task_parent_required: only the connection that owns this task child may pause or resume it for a run',
	abort_compaction: "ok",
	reload: "ok{cancelled}",
	check_reload_veto: "ok{cancelled}",
	clear_queue: "ok{followUp,ordered,steering}",
	dequeue_message: '{"queuedId":"$NO"} => ok{action,queuedId,reason,status}',
	edit_queued_message: '{"queuedId":"$NO","text":"Edited."} => ok{action,queuedId,reason,status}',
	get_steering_messages: "ok{messages,ordered}",
	get_follow_up_messages: "ok{messages,ordered}",
	abort_branch_summary: "ok",
	new_session: "ok{cancelled}",
	wake: "ok{admitted}",
	get_state:
		"ok{answeredUiRequests,autoCompactionEnabled,contextUsage,cwd,entries,fastMode,favoriteModels,followUp,followUpMode,holds,isBashRunning,isCompacting,isStreaming,lifecycle,messageCount,model,ordered,pause,paused,pausedHeldInputCount,pausedNoticeCount,pendingDialogs,pendingMessageCount,pendingModelSwitch,pendingQuestions,projectTrusted,retryAttempt,runPaused,scopedModels,sessionFile,sessionId,sessionModelThinkingLevels,steering,steeringMode,thinkingLevel,thinkingLevelSource,usageTotals}",
	get_snapshot: '{"tail":0} => ok{entries,history_truncated,markerId,next_before,state}',
	request_self_settle: "ok{epoch,humanInputRevision,reason,recorded}",
	get_effect_status: '{"effectId":"$NO"} => ok{found,searched}',
	get_pending_inputs: "ok{inputs,lifetimeId,outcomes,throughCursor}",
	set_model:
		'{"provider":"faux","modelId":"faux-1"} => ok{api,baseUrl,contextWindow,cost,id,input,maxTokens,name,provider,reasoning}',
	set_favorite_models: '{"models":[]} => ok',
	set_scoped_models: '{"models":[]} => ok',
	cycle_model: "ok:object",
	get_available_models: "ok{models}",
	set_thinking_level: '{"level":"off"} => ok',
	cycle_thinking_level: "ok:object",
	get_available_thinking_levels: "ok{levels}",
	get_model_thinking_level: '{"provider":"faux","modelId":"faux-1"} => ok{availableLevels,level,source}',
	set_fast_mode: '{"enabled":false} => no::Fast mode is only available for ChatGPT Subscription models.',
	get_fast_mode: "ok{enabled,serviceTier}",
	set_steering_mode: '{"mode":"all"} => ok',
	set_follow_up_mode: '{"mode":"all"} => ok',
	compact: "no::Nothing to compact (session too small)",
	set_auto_compaction: '{"enabled":false} => ok',
	set_auto_retry: '{"enabled":false} => ok',
	abort_retry: "ok",
	set_retry_fallback:
		'{"retryFallback":{}} => no::set_retry_fallback is for a single-session rpc process; a host session takes open_session.retryFallback.',
	bash: '{"command":"true"} => ok{cancelled,exitCode,output,truncated}',
	record_bash_result:
		'{"command":"true","result":{"output":"","exitCode":0,"cancelled":false,"truncated":false}} => ok',
	abort_bash: "ok",
	cleanup_bash_output: '{"path":"$TMP/missing.txt"} => ok',
	set_label: '{"entryId":"$NO","label":"x14"} => no::Entry <uuid> not found',
	navigate_tree: '{"entryId":"$NO"} => no:not_found:Entry <uuid> not found',
	get_session_stats:
		"ok{assistantMessages,contextUsage,cost,failures,sessionFile,sessionId,tokens,toolCalls,toolResults,totalMessages,userMessages}",
	resolve_path: '{"path":"."} => ok{base,kind,realpath,status}',
	memory_report: "no::memory_report_disabled: start the host with SENPI_MEMORY_REPORT=1",
	export_html: '{"outputPath":"$TMP/x14.html"} => no::Nothing to export yet - start a conversation first',
	export_jsonl: '{"outputPath":"$TMP/x14.jsonl"} => ok{path}',
	switch_session: '{"sessionPath":"$TMP/missing.jsonl"} => ok{cancelled}',
	fork: '{"entryId":"$NO"} => no::Invalid entry ID for forking',
	edit_assistant_message: '{"entryId":"$NO","text":"Edited."} => no:not_found:Entry <uuid> not found',
	edit_user_message: '{"entryId":"$NO","text":"Edited."} => no:not_found:Entry <uuid> not found',
	clone: "no::This session has not been saved yet. Send a message before cloning or forking it.",
	get_fork_messages: "ok{messages}",
	get_entries: "ok{entries,leafId}",
	get_tree: "ok{leafId,tree}",
	get_last_assistant_text: "ok{}",
	set_session_name: '{"name":"X14"} => ok',
	record_user_activity: '{"kind":"draft"} => ok',
	import_jsonl: '{"inputPath":"$TMP/missing.jsonl"} => no::File not found: <tmp>/missing.jsonl',
	get_messages: "ok{messages}",
	get_media: '{"toolCallId":"$NO","contentIndex":0} => no:media_not_found:media_not_found',
	get_commands: "ok{commands}",
	get_loaded_surfaces: "ok{extensions,mcpServers}",
	extension_request: '{"name":"x14-none"} => no::Unknown extension RPC request: x14-none',
	"eval_cells.list": "ok:object",
	"eval_cells.peek": '{"cellId":"$NO"} => no:eval_cell_not_found:Unknown detached eval cell "<uuid>"',
	"eval_cells.stop": '{"cellId":"$NO"} => no:eval_cell_not_found:Unknown detached eval cell "<uuid>"',
	get_auth_providers: "ok{providers}",
	login_start: '{"provider":"x14-none"} => ok',
	login_cancel: '{"provider":"x14-none"} => ok',
	login_api_key: '{"provider":"x14-none","key":"x14-not-a-key"} => ok',
	logout: '{"provider":"x14-none"} => ok',
	verify_api_key: '{"provider":"x14-none","key":"x14-not-a-key"} => ok{ok,reason}',
	get_provider_accounts: '{"provider":"x14-none"} => ok{accounts,ordered}',
	account_pin: '{"provider":"x14-none","name":null} => no::No stored credential for provider: x14-none',
	account_remove: '{"provider":"x14-none","name":"x14"} => no::Provider account not found: x14',
	account_order: '{"provider":"x14-none","names":null} => no::No stored credential for provider: x14-none',
	test_provider_account: '{"provider":"x14-none","name":"x14"} => no::unsupported_provider',
	set_client_info: '{"width":80} => ok',
};

async function startHost() {
	const scratch = mkdtempSync(join(tmpdir(), "senpi-x14-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	for (const dir of [cwd, agentDir]) mkdirSync(dir);
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET"]) vi.stubEnv(name, undefined);
	vi.stubEnv("PI_RPC_SOCKET", undefined);
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 128_000 }] });
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			permissionPreset: "full-access",
			createRuntime: createCliRuntimeFactory(
				{ parsed: parseArgs(LEAN_ARGS), cwd, agentDir, appMode: "rpc" },
				{ extensionFactories: [(pi) => pi.registerProvider(faux.provider)] },
			),
			creationModel: { provider: faux.getModel().provider, modelId: "faux-1" },
		},
		writer,
		[],
	);
	const server = createServer((socket) => {
		writer.registerConnection("socket-1", socketSink(socket));
		socket.once("close", () => writer.unregisterConnection("socket-1"));
		socket.once("error", () => writer.unregisterConnection("socket-1"));
		attachJsonlLineReader(socket, (line) => void writer.withConnection("socket-1", () => core.handle(line)));
	});
	const socketPath = join(scratch, "host.sock");
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = connect(socketPath);
	await new Promise<void>((resolve) => client.once("connect", resolve));
	const answers = new Map<string, (record: WireRecord) => void>();
	attachJsonlLineReader(client, (line) => {
		const record = JSON.parse(line) as WireRecord;
		if (record.type === "response" && typeof record.id === "string") answers.get(record.id)?.(record);
	});
	let serial = 0;
	return {
		scratch,
		send(command: WireRecord): Promise<WireRecord> {
			const id = `x14-${++serial}`;
			client.write(`${JSON.stringify({ ...command, id })}\n`);
			return new Promise<WireRecord>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no answer to ${String(command.type)}`)), 20_000);
				answers.set(id, (record) => {
					clearTimeout(timer);
					resolve(record);
				});
			});
		},
		async dispose(): Promise<void> {
			await core.router.dispose();
			client.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(scratch, { recursive: true, force: true });
			vi.unstubAllEnvs();
		},
	};
}

function signature(record: WireRecord, method: string, scratch: string): string {
	const envelope = record.command === method ? "" : `command=${String(record.command)}|`;
	const data = record.data;
	if (record.success !== true) {
		const text = String(record.error).split(scratch).join("<tmp>").replace(UUID, "<uuid>");
		return `${envelope}no:${String(record.errorCode ?? "")}:${text}`;
	}
	if (data === undefined) return `${envelope}ok`;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return `${envelope}ok:${typeof data}`;
	return `${envelope}ok{${Object.keys(data).sort().join(",")}}`;
}

/** Splits a table row into its request payload (placeholders filled) and today's answer. */
function parseRow(row: string, opened: Opened, tmp: string): { payload: WireRecord; answer: string } {
	const split = row.indexOf(" => ");
	if (split < 0) return { payload: {}, answer: row };
	const fill: Record<string, string> = { SID: opened.sessionId, PATH: opened.state.sessionFile, NO: NO_ID, TMP: tmp };
	const json = row.slice(0, split).replace(/\$(SID|PATH|NO|TMP)/g, (_, name: string) => fill[name] ?? name);
	return { payload: JSON.parse(json) as WireRecord, answer: row.slice(split + 4) };
}

async function openFresh(): Promise<Opened> {
	return (await host.send({ type: "open_session" })).data as Opened;
}

let host: Awaited<ReturnType<typeof startHost>>;
beforeAll(async () => {
	host = await startHost();
});
afterAll(async () => {
	await host.dispose();
});

describe("X14: RPC method surface on the local socket", () => {
	it("answers every method in today's handler table with today's answer, and refuses any other method", async () => {
		const actual: Record<string, string> = {};
		const today: Record<string, string> = {};
		for (const [method, row] of Object.entries(TODAY)) {
			const session = await openFresh();
			const { payload, answer } = parseRow(row, session, host.scratch);
			const routing = HOST_METHODS.has(method) ? {} : { sessionId: session.sessionId };
			actual[method] = signature(await host.send({ type: method, ...routing, ...payload }), method, host.scratch);
			today[method] = answer;
		}
		const stray = await host.send({ type: "x14_not_a_method", sessionId: (await openFresh()).sessionId });
		actual.x14_not_a_method = signature(stray, "x14_not_a_method", host.scratch);
		today.x14_not_a_method = "no::Unknown command: x14_not_a_method";
		expect(actual).toEqual(today);
	}, 300_000);
});
