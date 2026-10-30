import type { ExtensionAPI, ToolDefinition } from "./core/extensions/types.ts";

/** Public callable names the opening host may serve, encoded as a comma-separated session label. */
export const HOST_TOOL_NAMES_CONTEXT_KEY = "host_tool_names";
/** Event-bus channel on which a host bridge sets (`execute`) or clears (no `execute`) the route for one name. */
export const HOST_TOOL_ROUTE_CHANNEL = "senpi:host-tool-route";
/** The `Error.name` a route throws when its host cannot serve the call; the call then runs on the standalone tool. */
export const HOST_TOOL_ROUTE_UNAVAILABLE = "HostToolRouteUnavailable";

type Execute = ToolDefinition["execute"];

const routeFor = (data: unknown, name: string): { readonly matched: boolean; readonly execute?: Execute } => {
	if (typeof data !== "object" || data === null || !("name" in data) || data.name !== name) return { matched: false };
	return "execute" in data && typeof data.execute === "function"
		? {
				matched: true,
				execute: (...args) => Promise.resolve(Reflect.apply(data.execute as Execute, undefined, args)),
			}
		: { matched: true };
};

/**
 * Attach host tools through the SDK. Each tool is registered exactly once, under its own name, and always serves:
 * a host bridge may route its calls to the host once the host is confirmed, and a route that reports
 * `HOST_TOOL_ROUTE_UNAVAILABLE` is dropped and the call runs on the standalone implementation.
 */
export function attachHostTools(
	api: Pick<ExtensionAPI, "registerTool" | "events">,
	tools: readonly ToolDefinition[],
): void {
	for (const tool of tools) {
		let route: Execute | undefined;
		api.events.on(HOST_TOOL_ROUTE_CHANNEL, (data) => {
			const update = routeFor(data, tool.name);
			if (update.matched) route = update.execute;
		});
		api.registerTool({
			...tool,
			async execute(...args) {
				const routed = route;
				if (routed === undefined) return tool.execute(...args);
				try {
					return await routed(...args);
				} catch (error) {
					if (!(error instanceof Error) || error.name !== HOST_TOOL_ROUTE_UNAVAILABLE) throw error;
					if (route === routed) route = undefined;
					return tool.execute(...args);
				}
			},
		});
	}
}
