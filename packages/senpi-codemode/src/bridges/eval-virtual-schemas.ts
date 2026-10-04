import type { EvalSchemaResult } from "./schema-bridge.ts";

/**
 * Virtual `tool_schema("eval:*")` entries: documentation a cell can read on demand. They are not tools,
 * never execute anything, and never appear in the ordinary catalog listing, so the eval prompt and the
 * host tool list stay byte-identical.
 */
const handleRefSchema = {
	type: "object",
	description:
		"A saved handle reference. agent(..., {handle: true}) records, handle() views, completion handles and workpools ({pool_id}) are accepted directly.",
	properties: {
		kind: { enum: ["agent", "completion", "workpool"] },
		id: { type: "string" },
		run_epoch: {
			type: "integer",
			minimum: 0,
			description:
				"The run this reference is bound to; a resumed task gets a new epoch and the old reference fails with eval_handle_stale.",
		},
	},
	required: ["kind", "id", "run_epoch"],
} as const;

const waitEntry: EvalSchemaResult = {
	name: "eval:wait",
	description: [
		"wait(handles, {timeout?, mode?}) blocks the cell until the given handles settle (js: await wait(...); py/rb: wait(...); jl: wait(handle(node)) or wait([handle(a), handle(b)])).",
		'mode "all" (default) returns the successful values in input order and raises the first failed, cancelled or lost handle\'s error; "any" returns {index, ref, value} of the first success or eval_wait_all_rejected; "settled" returns one {status, ref, value|error} outcome per input slot.',
		"Duplicates keep their slots with one subscription. Empty handles: all/settled -> [], any -> eval_wait_empty.",
		"timeout is wall-clock seconds from entry (finite, >= 0; 0 = one atomic check; omitted = no wait-specific deadline). On timeout the subscription closes and `eval_wait_timeout: wait() timed out after Ns; k/n handles settled; work was not cancelled` is raised. wait() never cancels work.",
		"wait() rides the bridge-call path: the cell's run budget pauses while parked, the hard limit never pauses, and a long barrier detaches like any bridge-parked cell. Cancelling the cell closes its subscriptions at once. Task and workpool notifications are neither consumed nor suppressed.",
		"A workpool must be closed first (eval_pool_open) and succeeds only when every key succeeds (eval_workpool_failed carries the keyed aggregate).",
		"Agent and workpool handles need the host capability; without it wait() fails with eval_wait_unavailable and never polls task_output. Completion handles always work.",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			handles: { type: "array", items: handleRefSchema },
			timeout: { type: "number", minimum: 0, description: "Wall-clock seconds from entry." },
			mode: { enum: ["all", "any", "settled"], default: "all" },
		},
		required: ["handles"],
	},
};

const helpersEntry: EvalSchemaResult = {
	name: "eval:helpers",
	description: [
		"Advanced cell helpers (all four languages; js helpers are awaited).",
		"handle(node | ref | {pool_id}) returns a rich view: the legacy fields plus a non-enumerable `control` (py: attribute, rb: singleton method) with status(), output({format, offset, limit}), send(message) (agent handles only; others eval_handle_operation_unsupported), cancel() (idempotent for that run epoch; never cancels a successor run) and wait({timeout}).",
		"control.status() goes through the host subscription; control.send/cancel/output are fenced by owner, id and run_epoch inside the task owner (stale -> eval_handle_stale, foreign -> eval_handle_forbidden); control.output() returns only that epoch's transcript. The plain output() helper and task tools are unchanged.",
		"The legacy agent(..., {handle: true}) record is unchanged: .output stays a string and no enumerable key is added. A saved {kind, id, run_epoch} (or the record itself) can be rebound with handle(ref) in a later cell or after a kernel reset while the owner and run epoch are valid.",
		"completion(prompt, {handle: true}) (py: handle=True) returns a control handle after preflight validation; provider failures surface in its outcome; its deadline derives from the creating cell's hard deadline. Completion handles are codemode-owned and need no host capability; once the session generation is dropped they fail with eval_handle_stale.",
		"See tool_schema('eval:wait') for the barrier semantics.",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			wait: { description: "wait(handles, {timeout?, mode?}) -> values | {index, ref, value} | outcomes[]" },
			handle: { description: "handle(node | ref | {pool_id}) -> view with .control" },
			"control.status": { description: "() -> {ref, phase, host_status, revision}" },
			"control.output": { description: "({format?, offset?, limit?}) -> {ref, text, offset, total, truncated}" },
			"control.send": { description: "(message) -> snapshot; agent handles only" },
			"control.cancel": { description: "() -> {ref, cancelled, phase}" },
			"control.wait": { description: "({timeout?}) -> value" },
			completion: { description: "completion(prompt, {handle: true}) -> control handle" },
		},
	},
};

const VIRTUAL_ENTRIES: ReadonlyMap<string, EvalSchemaResult> = new Map([
	[waitEntry.name, waitEntry],
	[helpersEntry.name, helpersEntry],
]);

export function virtualEvalSchema(name: string): EvalSchemaResult | undefined {
	return VIRTUAL_ENTRIES.get(name);
}
