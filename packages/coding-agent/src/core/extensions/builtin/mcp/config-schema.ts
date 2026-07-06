import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const LogLevelSchema = Type.Union([
	Type.Literal("debug"),
	Type.Literal("info"),
	Type.Literal("notice"),
	Type.Literal("warning"),
	Type.Literal("error"),
	Type.Literal("critical"),
	Type.Literal("alert"),
	Type.Literal("emergency"),
]);

const OAuthSchema = Type.Object(
	{
		clientId: Type.Optional(Type.String()),
		scopes: Type.Optional(Type.Array(Type.String())),
		clientMetadataUrl: Type.Optional(Type.String()),
		flow: Type.Optional(Type.Union([Type.Literal("code"), Type.Literal("client_credentials")])),
	},
	{ additionalProperties: false },
);

export const ServerSchema = Type.Object(
	{
		type: Type.Optional(Type.Union([Type.Literal("stdio"), Type.Literal("http")])),
		url: Type.Optional(Type.String()),
		command: Type.Optional(Type.String()),
		args: Type.Optional(Type.Array(Type.String())),
		env: Type.Optional(Type.Record(Type.String(), Type.String())),
		cwd: Type.Optional(Type.String()),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		auth: Type.Optional(Type.Union([Type.Literal("bearer"), Type.Literal("oauth"), Type.Literal(false)])),
		bearerTokenEnv: Type.Optional(Type.String()),
		oauth: Type.Optional(OAuthSchema),
		enabled: Type.Optional(Type.Boolean()),
		lifecycle: Type.Optional(Type.Union([Type.Literal("lazy"), Type.Literal("eager"), Type.Literal("keep-alive")])),
		idleTimeoutMin: Type.Optional(Type.Number()),
		requestTimeoutMs: Type.Optional(Type.Number()),
		connectTimeoutMs: Type.Optional(Type.Number()),
		includeTools: Type.Optional(Type.Array(Type.String())),
		excludeTools: Type.Optional(Type.Array(Type.String())),
		directTools: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
		exposure: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("direct"), Type.Literal("search"), Type.Literal("proxy")]),
		),
		logLevel: Type.Optional(LogLevelSchema),
	},
	{ additionalProperties: false },
);

const SettingsSchema = Type.Object(
	{
		toolPrefix: Type.Optional(Type.String()),
		searchThreshold: Type.Optional(Type.Number()),
		outputGuard: Type.Optional(
			Type.Object(
				{
					maxBytes: Type.Optional(Type.Number()),
					maxLines: Type.Optional(Type.Number()),
					maxTokens: Type.Optional(Type.Number()),
				},
				{ additionalProperties: false },
			),
		),
		importConfigs: Type.Optional(Type.Array(Type.Literal("claude"))),
		oauthCallbackUrl: Type.Optional(Type.String()),
		stubSwap: Type.Optional(Type.Boolean()),
		nativeToolSearch: Type.Optional(Type.Union([Type.Literal("auto"), Type.Boolean()])),
	},
	{ additionalProperties: false },
);

export const ConfigSchema = Type.Object(
	{
		settings: Type.Optional(SettingsSchema),
		mcpServers: Type.Optional(Type.Record(Type.String(), ServerSchema)),
	},
	{ additionalProperties: false },
);

export type RawConfig = Static<typeof ConfigSchema>;
export type McpServerConfig = Static<typeof ServerSchema> & {
	type: "stdio" | "http";
	args: string[];
	enabled: boolean;
	lifecycle: "lazy" | "eager" | "keep-alive";
	connectTimeoutMs: number;
	requestTimeoutMs: number;
	idleTimeoutMin: number;
	exposure: "auto" | "direct" | "search" | "proxy";
	logLevel: Static<typeof LogLevelSchema>;
};
export type McpSettings = Required<Pick<Static<typeof SettingsSchema>, "toolPrefix">> &
	Omit<Static<typeof SettingsSchema>, "toolPrefix">;
export type McpServerSource = "global" | "claude" | "project";
export type McpServerState = "enabled" | "disabled" | "untrusted";

export interface ResolvedMcpServer {
	name: string;
	source: McpServerSource;
	sourcePath: string;
	state: McpServerState;
	transport?: "stdio" | "http";
	configHash?: string;
	config?: McpServerConfig;
}

export interface ResolvedMcpConfig {
	settings: McpSettings;
	servers: Record<string, ResolvedMcpServer>;
	diagnostics: string[];
}

export interface LoadMcpConfigOptions {
	cwd: string;
	agentDir?: string;
	env?: Record<string, string | undefined>;
	projectTrusted: boolean;
}

export function getServerEndpointValidationError(config: RawConfig): string | undefined {
	for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
		if (server.enabled === false) continue;
		const type = server.type ?? (server.url ? "http" : "stdio");
		if (type === "stdio" && (server.command === undefined || server.command.trim().length === 0)) {
			return `mcpServers.${name}.command: Required for enabled stdio server`;
		}
		if (type === "http" && (server.url === undefined || server.url.trim().length === 0)) {
			return `mcpServers.${name}.url: Required for enabled http server`;
		}
	}
	return undefined;
}

export const validateConfig = Compile(ConfigSchema);
export const defaultSettings: McpSettings = { toolPrefix: "mcp" };
