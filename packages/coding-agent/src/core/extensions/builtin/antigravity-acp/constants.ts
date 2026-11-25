export const ANTIGRAVITY_ACP_PROVIDER_ID = "antigravity-acp";
export const ANTIGRAVITY_ACP_API_ID = "antigravity-acp";
export const ANTIGRAVITY_ACP_NAME = "Antigravity (agy ACP)";
export const BRIDGE_SERVER_NAME = "senpi-host";
export const AGENT_NAME = "senpi-host";
export const SETTINGS_KEY = "antigravityAcpProvider";
export const BRIDGE_TOOL_PREFIX = `mcp_${BRIDGE_SERVER_NAME}_`;

export const ACP_CLIENT_INFO = {
	name: "senpi",
	title: "Senpi",
	version: "1.0.0",
} as const;

/** Non-empty marker for senpi's auth layer; never sent to any remote endpoint. */
export const SENTINEL_API_KEY = "antigravity-acp";
