import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { PromptDisposition, QueuedInput, QueuedInputDisposition } from "../../core/agent-session.ts";

import type { BashResult } from "../../core/bash-executor.ts";

import type { ClientMessageIdentity } from "../../core/client-message-identity.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";

import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import type { SessionControlAdmission } from "../../core/extensions/types.ts";

import type { ApiKeyVerification } from "../../core/verify-api-key.ts";

import type { ClientMessageAdmission } from "./client-admission-record.ts";
import type { RpcAbortQuiesce, RpcEffectAnswer, RpcQueuedInputChange } from "./rpc-effect-answer-types.ts";
import type { EditAssistantMessageResult, EditUserMessageResult, NavigateTreeResult } from "./rpc-result-types.ts";
import type { RpcProviderAccount } from "./rpc-session-state-types.ts";
import type { RpcMoveSessionResponse } from "./session-move-wire.ts";

export type RpcMutationResponse =
	| {
			id?: string;
			type: "response";
			command: "wake";
			success: true;
			data: { admitted: readonly SessionControlAdmission[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "prompt";
			success: true;
			data?: ClientMessageIdentity & {
				disposition?: PromptDisposition;
				admission?: ClientMessageAdmission;
				/** Kept as a notice: automatic input while the user's Stop holds the session (senpi#3811). */
				heldAsNotice?: boolean;
			};
	  }
	| { id?: string; type: "response"; command: "send_custom_message"; success: true }
	| { id?: string; type: "response"; command: "append_user_message"; success: true }
	| { id?: string; type: "response"; command: "append_session_entry"; success: true }
	| {
			id?: string;
			type: "response";
			command: "steer";
			success: true;
			data?: ClientMessageIdentity & {
				disposition?: QueuedInputDisposition;
				admission?: ClientMessageAdmission;
				heldAsNotice?: boolean;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "follow_up";
			success: true;
			data?: ClientMessageIdentity & {
				disposition?: QueuedInputDisposition;
				admission?: ClientMessageAdmission;
				heldAsNotice?: boolean;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "abort";
			success: true;
			data?: RpcEffectAnswer | (Partial<RpcEffectAnswer> & RpcAbortQuiesce);
	  }
	| {
			id?: string;
			type: "response";
			command: "release_tool_barrier";
			success: true;
			/** False when no barrier with that id was armed (never armed, already released, ended, or expired). */
			data: { released: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "dequeue_message" | "edit_queued_message";
			success: true;
			data: RpcQueuedInputChange & Partial<RpcEffectAnswer>;
	  }
	| {
			id?: string;
			type: "response";
			command: "interrupt";
			success: true;
			data: { interrupted: boolean; turnId?: string };
	  }
	| { id?: string; type: "response"; command: "abort_compaction"; success: true }
	| { id?: string; type: "response"; command: "reload"; success: true; data: { cancelled: boolean; reason?: string } }
	| {
			id?: string;
			type: "response";
			command: "check_reload_veto";
			success: true;
			data: { cancelled: boolean; reason?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "clear_queue";
			success: true;
			data: {
				steering: string[];
				followUp: string[];
				ordered: QueuedInput[];
			};
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			/** With `effectId`: the effect fields beside the model, or only them on a replay. */
			data: (Model<any> & { systemPromptName?: string } & Partial<RpcEffectAnswer>) | RpcEffectAnswer;
	  }
	| { id?: string; type: "response"; command: "set_favorite_models"; success: true }
	| { id?: string; type: "response"; command: "set_scoped_models"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| { id?: string; type: "response"; command: "continue_from_leaf"; success: true }
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true; data?: RpcEffectAnswer }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; serviceTier: ServiceTier; provider: string; modelId: string };
	  }
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| { id?: string; type: "response"; command: "set_retry_fallback"; success: true }
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| {
			id?: string;
			type: "response";
			command: "navigate_tree";
			success: true;
			/**
			 * `NavigateTreeResult` answers an `entryId` navigation; the shipped shape answers a
			 * `targetId` one. Both report `leafId` - the leaf the session was left on, `null` for an
			 * empty conversation - so a client resynchronizes in one round trip on either spelling.
			 */
			data:
				| NavigateTreeResult
				| {
						cancelled: boolean;
						leafId: string | null;
						editorText?: string;
						aborted?: boolean;
						summaryEntry?: unknown;
				  };
	  }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "export_jsonl"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "edit_assistant_message";
			success: true;
			data: EditAssistantMessageResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "edit_user_message";
			success: true;
			data: EditUserMessageResult;
	  }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "record_user_activity"; success: true }
	| { id?: string; type: "response"; command: "import_jsonl"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "extension_request";
			success: true;
			data: unknown;
	  }
	| { id?: string; type: "response"; command: "login_start"; success: true }
	| { id?: string; type: "response"; command: "login_cancel"; success: true }
	| {
			id?: string;
			type: "response";
			command: "login_api_key";
			success: true;
			/** Present when the key replaced a login of the other kind; `backupPath` holds the previous file (senpi#3448). */
			data?: { replaced: "oauth" | "api_key"; backupPath?: string };
	  }
	| { id?: string; type: "response"; command: "logout"; success: true; data?: { notices: string[] } }
	| {
			id?: string;
			type: "response";
			command: "verify_api_key";
			success: true;
			data: ApiKeyVerification;
	  }
	| RpcMoveSessionResponse
	| { id?: string; type: "response"; command: "account_pin"; success: true }
	| { id?: string; type: "response"; command: "account_remove"; success: true; data?: { notice: string } }
	| { id?: string; type: "response"; command: "account_order"; success: true }
	| {
			id?: string;
			type: "response";
			command: "test_provider_account";
			success: true;
			data: { check: NonNullable<RpcProviderAccount["check"]> };
	  }
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			errorCode?: string;
			errorData?: unknown;
	  };
