export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue | undefined };
export type AbsolutePathBuf = string;
export type LegacyAppPathString = string;
export type RequestId = string | number;
export type ThreadId = string;

export type ClientInfo = { readonly name: string; readonly title: string | null; readonly version: string };

export type InitializeCapabilities = {
	readonly experimentalApi: boolean;
	readonly requestAttestation: boolean;
	readonly mcpServerOpenaiFormElicitation?: boolean;
	readonly optOutNotificationMethods?: readonly string[] | null;
};

export type InitializeParams = {
	readonly clientInfo: ClientInfo;
	readonly capabilities: InitializeCapabilities | null;
};

export type InitializeResponse = {
	readonly userAgent: string;
	readonly codexHome: AbsolutePathBuf;
	readonly platformFamily: string;
	readonly platformOs: string;
};

export type AskForApproval =
	| "untrusted"
	| "on-request"
	| {
			readonly granular: {
				readonly sandbox_approval: boolean;
				readonly rules: boolean;
				readonly skill_approval: boolean;
				readonly request_permissions: boolean;
				readonly mcp_elicitations: boolean;
			};
	  }
	| "never";

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxPolicy =
	| { readonly type: "dangerFullAccess" }
	| { readonly type: "readOnly"; readonly networkAccess: boolean }
	| { readonly type: "externalSandbox"; readonly networkAccess: "restricted" | "enabled" }
	| {
			readonly type: "workspaceWrite";
			readonly writableRoots: readonly AbsolutePathBuf[];
			readonly networkAccess: boolean;
			readonly excludeTmpdirEnvVar: boolean;
			readonly excludeSlashTmp: boolean;
	  };

export type Personality = "none" | "friendly" | "pragmatic";
export type MultiAgentMode = "explicitRequestOnly" | "proactive" | { readonly custom: string };
export type ReasoningEffort = string;
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type ServiceTier = string;
export type ThreadSource = string;
export type ThreadStartSource = string;
export type ThreadSourceKind =
	| "cli"
	| "vscode"
	| "exec"
	| "appServer"
	| "subAgent"
	| "subAgentReview"
	| "subAgentCompact"
	| "subAgentThreadSpawn"
	| "subAgentOther"
	| "unknown";
export type SessionSource = ThreadSourceKind | { readonly custom: string } | { readonly subAgent: JsonValue };
export type SortDirection = "asc" | "desc";
export type ThreadStatus =
	| { readonly type: "notLoaded" }
	| { readonly type: "idle" }
	| { readonly type: "systemError" }
	| { readonly type: "active"; readonly activeFlags: readonly JsonValue[] };
export type ThreadUnsubscribeStatus = string;

export type AdditionalContextEntry = { readonly value: string; readonly kind: string };
export type UserInput =
	| { readonly type: "text"; readonly text: string; readonly text_elements?: readonly JsonValue[] }
	| { readonly type: "image"; readonly detail?: string; readonly url: string }
	| { readonly type: "localImage"; readonly detail?: string; readonly path: string }
	| { readonly type: "skill"; readonly name: string; readonly path: string }
	| { readonly type: "mention"; readonly name: string; readonly path: string };
export type TurnEnvironmentParams = JsonValue;
export type DynamicToolSpec = JsonValue;
export type SelectedCapabilityRoot = JsonValue;
export type ActivePermissionProfile = { readonly id: string; readonly extends: string | null };
export type GitInfo = {
	readonly sha: string | null;
	readonly branch: string | null;
	readonly originUrl: string | null;
};
export type RemoteControlConnectionStatus = "disabled" | "connecting" | "connected" | "errored";
