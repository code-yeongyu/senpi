import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_NAME, getAgentDir } from "../config.ts";
import { DEFAULT_HOST_LAUNCH_SPEC, HostLaunchSpecError, loadHostLaunchSpec } from "../modes/rpc/host-launch-spec.ts";
import { HOST_EXIT_ERROR, HOST_EXIT_USAGE } from "../modes/rpc/host-outcome.ts";
import { type HostSessionRequest, runHostSessionRequest } from "../modes/rpc/host-session-runner.ts";
import { resolveHostSocket } from "./host-command.ts";
import { emit } from "./host-emit.ts";

const USAGE = `usage: ${APP_NAME} host session <command> [--socket <path>] [--json]

  open --cwd <dir> [--model <provider/id>] [--name <text>] [--prompt <text|@file>] [--launch-spec <file>]
  close <ref>
  model <ref> <provider/id>
  prompt <ref> <text|@file>
  steer <ref> <text|@file>
  abort <ref>
  read <ref> [--tail <N>] [--since <entryId>] [--messages]
  state <ref>
  list
  wait <ref> [--until idle|done] [--timeout <ms>]

Every command prints one JSON line. wait defaults to idle and 600000 ms.
@file is verbatim UTF-8 prompt text (BOM stripped), not an attachment wrapper.
References accept a host session id, durable session id, path, or name.`;

type CommandArgs<T> = T extends HostSessionRequest ? Omit<T, "target" | "spec"> : never;
export interface ParsedHostSessionArgs {
	readonly command: CommandArgs<HostSessionRequest>;
	readonly socket?: string;
	readonly specPath?: string;
}

export function parseHostSessionArgs(args: readonly string[]): ParsedHostSessionArgs | string {
	const [action, ...rest] = args;
	if (
		!["open", "close", "model", "prompt", "steer", "abort", "read", "state", "list", "wait"].includes(action ?? "")
	) {
		return `Unknown host session command "${action ?? ""}".`;
	}
	const values: Record<string, string> = {};
	const positional: string[] = [];
	let messages = false;
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		if (flag === "--json") continue;
		if (flag === "--messages" && action === "read") {
			messages = true;
			continue;
		}
		if (!flag.startsWith("--")) {
			positional.push(flag);
			continue;
		}
		const allowed =
			flag === "--socket" ||
			(action === "open" && ["--cwd", "--model", "--name", "--prompt", "--launch-spec"].includes(flag)) ||
			(action === "read" && ["--tail", "--since"].includes(flag)) ||
			(action === "wait" && ["--until", "--timeout"].includes(flag));
		const value = rest[++index];
		if (!allowed || value === undefined || value.startsWith("--")) return `Invalid option or missing value: ${flag}.`;
		values[flag] = value;
	}
	const count =
		action === "open" || action === "list" ? 0 : ["model", "prompt", "steer"].includes(action ?? "") ? 2 : 1;
	if (positional.length !== count) return `${action} expects ${count} positional argument(s).`;
	const ref = positional[0] ?? "";
	const common = { socket: values["--socket"], specPath: values["--launch-spec"] };
	switch (action) {
		case "open": {
			if (!values["--cwd"]) return "open requires --cwd <dir>.";
			const model = values["--model"] === undefined ? undefined : parseModel(values["--model"]);
			if (typeof model === "string") return model;
			return {
				...common,
				command: {
					action,
					cwd: resolve(values["--cwd"]),
					model,
					name: values["--name"],
					prompt: values["--prompt"],
				},
			};
		}
		case "model": {
			const model = parseModel(positional[1]);
			return typeof model === "string" ? model : { ...common, command: { action, ref, model } };
		}
		case "prompt":
		case "steer":
			return { ...common, command: { action, ref, text: positional[1] } };
		case "close":
		case "abort":
		case "state":
			return { ...common, command: { action, ref } };
		case "list":
			return { ...common, command: { action } };
		case "read": {
			const tail = values["--tail"] === undefined ? undefined : integer(values["--tail"], 1);
			if (tail === null) return "--tail must be a positive integer.";
			if (messages && values["--since"] !== undefined) return "--since cannot be combined with --messages.";
			return { ...common, command: { action, ref, tail, since: values["--since"], messages } };
		}
		case "wait": {
			const until = values["--until"] ?? "idle";
			const timeoutMs = integer(values["--timeout"] ?? "600000", 0);
			if (until !== "idle" && until !== "done") return "--until must be idle or done.";
			if (timeoutMs === null) return "--timeout must be a non-negative integer.";
			return { ...common, command: { action, ref, until, timeoutMs } };
		}
		default:
			return `Unknown host session command "${action}".`;
	}
}

function parseModel(text: string): { provider: string; id: string } | string {
	const parts = text.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "Model must be provider/id.";
	return { provider: parts[0], id: parts[1] };
}

function integer(text: string, minimum: number): number | null {
	const value = Number(text);
	return /^\d+$/.test(text) && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function usage(reason: string, detail: string): number {
	process.stderr.write(`${detail}\n${USAGE}\n`);
	emit({ action: "error", reason, detail });
	return HOST_EXIT_USAGE;
}

export async function runHostSessionCommand(args: readonly string[]): Promise<number> {
	const parsed = parseHostSessionArgs(args);
	if (typeof parsed === "string") return usage("usage", parsed);
	try {
		const command = parsed.command;
		try {
			if ("text" in command) command.text = promptText(command.text);
			if (command.action === "open" && command.prompt !== undefined) command.prompt = promptText(command.prompt);
		} catch (error) {
			return usage("prompt_file_unreadable", error instanceof Error ? error.message : String(error));
		}
		const agentDir = getAgentDir();
		const target = { socket: resolveHostSocket(parsed.socket, agentDir), agentDir };
		const request: HostSessionRequest =
			command.action === "open"
				? {
						...command,
						target,
						spec:
							parsed.specPath === undefined
								? DEFAULT_HOST_LAUNCH_SPEC
								: await loadHostLaunchSpec(parsed.specPath),
					}
				: { ...command, target };
		const outcome = await runHostSessionRequest(request);
		emit(outcome.payload);
		return outcome.exitCode;
	} catch (error) {
		if (error instanceof HostLaunchSpecError) return usage(error.reason, error.detail);
		emit({ action: "error", reason: "host_error", detail: error instanceof Error ? error.message : String(error) });
		return HOST_EXIT_ERROR;
	}
}

function promptText(text: string): string {
	return text.startsWith("@") ? readFileSync(text.slice(1), "utf8").replace(/^\uFEFF/, "") : text;
}
