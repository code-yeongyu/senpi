import type { ExtensionContext, ExtensionUIDialogOptions } from "../../types.ts";
import type { Reply, ReplyInput, Request } from "./types.ts";

export async function showPermissionPrompt(
	ctx: ExtensionContext,
	request: Request,
	signal?: AbortSignal,
): Promise<ReplyInput> {
	const title = `Permission required: ${request.permission}`;
	const message = formatRequestForDisplay(request);

	const displayTitle = `${title}\n\n${message}`;

	const wider = request.widerAlways;
	const options = ["Allow once", "Allow always", ...(wider ? [wider.label] : []), "Deny", "Deny with feedback"];

	// Clients bind the dialog to the call it approves by this id; with several calls of one tool in
	// flight (the engine prepares a message's calls before running them), nothing else says which.
	const call: ExtensionUIDialogOptions = request.tool
		? {
				toolCallId: request.tool.callID,
				...(request.tool.parentCallID === undefined ? {} : { parentToolCallId: request.tool.parentCallID }),
			}
		: {};
	if (signal !== undefined) call.signal = signal;
	const choice = await ctx.ui.select(displayTitle, options, call);

	if (choice === "Deny with feedback") {
		const feedback = await ctx.ui.input("Feedback", "Why are you denying this permission? (optional)", call);
		return {
			requestID: request.id,
			reply: "reject",
			message: feedback || undefined,
		};
	}

	if (wider !== undefined && choice === wider.label) {
		return { requestID: request.id, reply: "always", always: [...wider.patterns] };
	}

	const replyMap: Record<string, Reply> = {
		"Allow once": "once",
		"Allow always": "always",
		Deny: "reject",
	};

	return {
		requestID: request.id,
		reply: choice ? replyMap[choice] : "reject",
	};
}

function formatRequestForDisplay(request: Request): string {
	const parts: string[] = [];
	const meta = request.metadata || {};

	switch (request.permission) {
		case "edit":
			parts.push(`File: ${meta.filepath || "Unknown"}`);
			break;
		case "read":
			parts.push(`Path: ${meta.filePath || "Unknown"}`);
			break;
		case "glob":
		case "grep":
			parts.push(`Pattern: ${meta.pattern || "Unknown"}`);
			break;
		case "list":
			parts.push(`Path: ${meta.path || "Unknown"}`);
			break;
		case "bash":
			if (meta.description) parts.push(`Description: ${meta.description}`);
			parts.push(`Command: $ ${meta.command || "Unknown"}`);
			break;
		case "websearch":
		case "codesearch":
			parts.push(`Query: ${meta.query || "Unknown"}`);
			break;
		case "external_directory": {
			// These are resolved targets, not approval globs. Caller metadata cannot name the
			// approved directory, and a literal '*' in a filename must survive (senpi#4316).
			for (const target of request.patterns.length ? request.patterns : ["Unknown"]) {
				parts.push(`Directory: ${target}`);
			}
			if (request.originalPaths?.length) {
				parts.push(`Requested paths:\n${request.originalPaths.map((p) => `  - ${p}`).join("\n")}`);
			}
			break;
		}
		default:
			parts.push(`Tool: ${request.permission}`);
			break;
	}

	if (request.patterns && request.patterns.length > 0) {
		parts.push(`\nPatterns:\n${request.patterns.map((p) => `  - ${p}`).join("\n")}`);
	}

	return parts.join("\n");
}
