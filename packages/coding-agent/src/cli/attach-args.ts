import type { Args } from "./args.ts";

/** Attachment flags are resolved before mode selection or any local session initialization. */
export function applyAttachArgs(args: Args): void {
	const value = args.unknownFlags.get("attach");
	if (value === undefined) return;
	args.unknownFlags.delete("attach");
	const error = (message: string) => args.diagnostics.push({ type: "error", message });
	if (typeof value !== "string" || value.length === 0) {
		error("--attach requires a local RPC endpoint address");
		return;
	}
	args.attach = value;
	if (args.mode && args.mode !== "text")
		error("--attach is interactive and cannot be combined with --mode rpc or json");
	if (!args.session && !args.help && !args.version) error("--attach requires --session <ref>");
	if (args.print || args.readStdin || args.messages.length || args.fileArgs.length)
		error("--attach needs interactive input; omit --print, stdin input, prompt arguments and @files");
	if (
		args.continue ||
		args.resume ||
		args.fork ||
		args.rebind ||
		args.sessionId ||
		args.noSession ||
		args.listen ||
		args.multiSession
	)
		error("--attach selects an existing session; omit session creation, resume and listener options");
	if (args.provider || args.model || args.apiKey || args.systemPrompt || args.appendSystemPrompt || args.export)
		error("--attach uses the endpoint's session configuration; omit model, prompt configuration and export options");
}
