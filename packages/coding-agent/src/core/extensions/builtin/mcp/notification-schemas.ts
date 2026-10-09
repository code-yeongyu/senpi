/**
 * Local zod definitions of the four server -> client notifications this client
 * subscribes to, plus the narrow client seam they register through.
 *
 * WHY NOT THE SDK'S SCHEMAS: `setNotificationHandler(schema, handler)` reads
 * the schema's method literal SYNCHRONOUSLY at registration time, and the three
 * subscribe helpers (`notifications.ts`, `resources.ts`, `logging.ts`) are
 * synchronous by contract. Importing `@modelcontextprotocol/sdk/types.js` for
 * them would drag the whole SDK back into the startup import graph, so the four
 * shapes are declared here instead — they are the stable, frozen part of the
 * MCP wire protocol, and only `notifications/message` carries a payload this
 * client actually reads. The SDK still does the parsing: it runs whichever
 * schema it is handed before invoking the handler.
 *
 * Fidelity to the SDK (`types.js`): the notification envelope is a stripping
 * object over `{ method, params }`, `params` carries an optional passthrough
 * `_meta`, and the list-changed notifications take no other parameters.
 *
 * WHY `zod/v3`: the SDK's compat layer parses a v3 schema through the schema's
 * OWN `safeParse`, so parsing never crosses between this package's zod and the
 * copy bundled with the SDK. WHY {@link McpNotificationClient}: the SDK types
 * its schema parameter against ITS bundled zod, and checking a schema built
 * from this package's zod against that copy's generic constraint exhausts the
 * type checker (TS2589). The seam below keeps the schema opaque to the SDK
 * signature while {@link registerMcpNotificationHandler} still ties the
 * handler's payload type to the schema that validates it.
 */
import { type ZodType, z } from "zod/v3";

/** The one method of the SDK client these subscriptions use. */
export interface McpNotificationClient<TNotification> {
	setNotificationHandler(schema: unknown, handler: (notification: TNotification) => void): void;
}

export function registerMcpNotificationHandler<TNotification>(
	client: McpNotificationClient<TNotification>,
	schema: ZodType<TNotification>,
	handler: (notification: TNotification) => void,
): void {
	client.setNotificationHandler(schema, handler);
}

export interface McpListChangedNotification {
	readonly method: string;
}

export interface McpResourceUpdatedNotification {
	readonly method: string;
	readonly params: { readonly uri: string };
}

export interface McpLoggingMessageNotification {
	readonly method: string;
	readonly params: { readonly level: string; readonly logger?: string; readonly data?: unknown };
}

const NotificationParamsSchema = z.object({ _meta: z.object({}).passthrough().optional() });

export const ToolListChangedNotificationSchema: ZodType<McpListChangedNotification> = z.object({
	method: z.literal("notifications/tools/list_changed"),
	params: NotificationParamsSchema.optional(),
});

export const ResourceListChangedNotificationSchema: ZodType<McpListChangedNotification> = z.object({
	method: z.literal("notifications/resources/list_changed"),
	params: NotificationParamsSchema.optional(),
});

export const PromptListChangedNotificationSchema: ZodType<McpListChangedNotification> = z.object({
	method: z.literal("notifications/prompts/list_changed"),
	params: NotificationParamsSchema.optional(),
});

export const ResourceUpdatedNotificationSchema: ZodType<McpResourceUpdatedNotification> = z.object({
	method: z.literal("notifications/resources/updated"),
	params: NotificationParamsSchema.extend({ uri: z.string() }),
});

export const LoggingMessageNotificationSchema: ZodType<McpLoggingMessageNotification> = z.object({
	method: z.literal("notifications/message"),
	params: NotificationParamsSchema.extend({
		level: z.enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]),
		logger: z.string().optional(),
		data: z.unknown(),
	}),
});
