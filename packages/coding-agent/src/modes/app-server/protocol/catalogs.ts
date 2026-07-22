import type { JsonValue, RemoteControlConnectionStatus } from "./base.ts";

export type RemoteControlStatusReadParams = undefined;
export type RemoteControlStatusReadResponse = {
	readonly status: RemoteControlConnectionStatus;
	readonly serverName: string;
	readonly installationId: string;
	readonly environmentId: string | null;
};
export type RemoteControlClientListOrder = "asc" | "desc";
export type RemoteControlClientListParams = {
	readonly environmentId: string;
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly order?: RemoteControlClientListOrder | null;
};
export type RemoteControlClient = {
	readonly clientId: string;
	readonly displayName: string | null;
	readonly deviceType: string | null;
	readonly platform: string | null;
	readonly osVersion: string | null;
	readonly deviceModel: string | null;
	readonly appVersion: string | null;
	readonly lastSeenAt: number | null;
};
export type RemoteControlClientListResponse = {
	readonly data: readonly RemoteControlClient[];
	readonly nextCursor: string | null;
};

export type SkillScope = "user" | "repo" | "system" | "admin";
export type SkillInterface = {
	readonly displayName?: string;
	readonly shortDescription?: string;
	readonly iconSmall?: string;
	readonly iconLarge?: string;
	readonly brandColor?: string;
	readonly defaultPrompt?: string;
};
export type SkillToolDependency = {
	readonly type: string;
	readonly value: string;
	readonly description?: string;
	readonly transport?: string;
	readonly command?: string;
	readonly url?: string;
};
export type SkillDependencies = { readonly tools: readonly SkillToolDependency[] };
export type SkillMetadata = {
	readonly name: string;
	readonly description: string;
	readonly shortDescription?: string;
	readonly interface?: SkillInterface;
	readonly dependencies?: SkillDependencies;
	readonly path: string;
	readonly scope: SkillScope;
	readonly enabled: boolean;
};
export type SkillErrorInfo = { readonly path: string; readonly message: string };
export type SkillsListEntry = {
	readonly cwd: string;
	readonly skills: readonly SkillMetadata[];
	readonly errors: readonly SkillErrorInfo[];
};
export type SkillsListParams = {
	readonly cwds?: readonly string[];
	readonly forceReload?: boolean;
};
export type SkillsListResponse = { readonly data: readonly SkillsListEntry[] };

export type McpServerStatusDetail = "full" | "toolsAndAuthOnly";
export type McpAuthStatus = "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
export type McpServerInfo = {
	readonly name: string;
	readonly title: string | null;
	readonly version: string;
	readonly description: string | null;
	readonly icons: readonly JsonValue[] | null;
	readonly websiteUrl: string | null;
};
export type Tool = {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: JsonValue;
	readonly outputSchema?: JsonValue;
	readonly annotations?: JsonValue;
	readonly icons?: readonly JsonValue[];
	readonly _meta?: JsonValue;
};
export type Resource = {
	readonly annotations?: JsonValue;
	readonly description?: string;
	readonly mimeType?: string;
	readonly name: string;
	readonly size?: number;
	readonly title?: string;
	readonly uri: string;
	readonly icons?: readonly JsonValue[];
	readonly _meta?: JsonValue;
};
export type ResourceTemplate = {
	readonly annotations?: JsonValue;
	readonly uriTemplate: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly mimeType?: string;
};
export type McpServerStatus = {
	readonly name: string;
	readonly serverInfo: McpServerInfo | null;
	readonly tools: Readonly<Record<string, Tool | undefined>>;
	readonly resources: readonly Resource[];
	readonly resourceTemplates: readonly ResourceTemplate[];
	readonly authStatus: McpAuthStatus;
};
export type McpServerStatusListParams = {
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly detail?: McpServerStatusDetail | null;
	readonly threadId?: string | null;
};
export type McpServerStatusListResponse = {
	readonly data: readonly McpServerStatus[];
	readonly nextCursor: string | null;
};

export type PermissionProfileSummary = {
	readonly id: string;
	readonly description: string | null;
	readonly allowed: boolean;
};
export type PermissionProfileListParams = {
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly cwd?: string | null;
};
export type PermissionProfileListResponse = {
	readonly data: readonly PermissionProfileSummary[];
	readonly nextCursor: string | null;
};

export type ExperimentalFeatureStage = "beta" | "underDevelopment" | "stable" | "deprecated" | "removed";
export type ExperimentalFeature = {
	readonly name: string;
	readonly stage: ExperimentalFeatureStage;
	readonly displayName: string | null;
	readonly description: string | null;
	readonly announcement: string | null;
	readonly enabled: boolean;
	readonly defaultEnabled: boolean;
};
export type ExperimentalFeatureListParams = {
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly threadId?: string | null;
};
export type ExperimentalFeatureListResponse = {
	readonly data: readonly ExperimentalFeature[];
	readonly nextCursor: string | null;
};
