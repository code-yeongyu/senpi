import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";

import type { SessionStats } from "../../core/agent-session.ts";

import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";

import type { ResolvedMessagePath } from "../../core/message-path-resolution.ts";
import type { PendingInputSnapshot } from "../../core/pending-input-session.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { ThinkingLevelSource } from "../../core/session-thinking-memory.ts";

import type { EffectStatus } from "./effect-record.ts";
import type { RpcSlashCommand } from "./rpc-command-surface.ts";
import type { RpcEvalCell, RpcEvalCellSnapshot } from "./rpc-result-types.ts";
import type {
	RpcAuthProvider,
	RpcLoadedExtension,
	RpcLoadedMcpServer,
	RpcProviderAccount,
	RpcSessionState,
} from "./rpc-session-state-types.ts";

import type { RpcSnapshot } from "./snapshot-types.ts";

export type RpcReadResponse =
	| { id?: string; type: "response"; command: "get_snapshot"; success: true; data: RpcSnapshot }
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "request_self_settle";
			success: true;
			data: import("../../core/session-lifecycle-types.ts").SelfSettleResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_effect_status";
			success: true;
			data: { found: true; effect: EffectStatus } | { found: false; searched: "complete" };
	  }
	| { id?: string; type: "response"; command: "get_pending_inputs"; success: true; data: PendingInputSnapshot }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: {
				models: Array<Model<any> & { supportedThinkingLevels: ThinkingLevel[]; supportsAssistantPrefill: boolean }>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_model_thinking_level";
			success: true;
			data: { level: ThinkingLevel; source: ThinkingLevelSource; availableLevels: ThinkingLevel[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_fast_mode";
			success: true;
			data: { enabled: boolean; serviceTier: ServiceTier | null };
	  }
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "resolve_path"; success: true; data: ResolvedMessagePath }
	| {
			id?: string;
			type: "response";
			command: "memory_report";
			success: true;
			data: { path: string; heapSnapshot?: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: {
				entries: SessionEntry[];
				leafId: string | null;
				hasMore?: boolean;
				nextSince?: string;
				/** A `tail` page's oldest entry id while older entries remain (senpi#4267). */
				next_before?: string;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| {
			id?: string;
			type: "response";
			command: "get_media";
			success: true;
			data: { toolCallId: string; contentIndex: number; content: ImageContent };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_loaded_surfaces";
			success: true;
			data: { extensions: RpcLoadedExtension[]; mcpServers: RpcLoadedMcpServer[] };
	  }
	| { id?: string; type: "response"; command: "eval_cells.list"; success: true; data: RpcEvalCell[] }
	| {
			id?: string;
			type: "response";
			command: "eval_cells.peek" | "eval_cells.stop";
			success: true;
			data: RpcEvalCellSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_auth_providers";
			success: true;
			data: { providers: RpcAuthProvider[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_provider_accounts";
			success: true;
			data: { accounts: RpcProviderAccount[]; ordered: boolean };
	  };
