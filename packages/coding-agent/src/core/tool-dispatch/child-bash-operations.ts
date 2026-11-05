/**
 * The user bash `BashOperations` under `--tool-runtime child` (senpi#3566 todo 9): `exec` runs the command as a
 * `user.bash` job on the session's tool child and feeds its streamed `{ data: <base64> }` updates to `onData`. The
 * environment is resolved here, on the server, exactly as the in-process operations resolve it.
 */

import { randomUUID } from "node:crypto";
import { getShellEnv } from "../../utils/shell.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { ToolChildKindRunner } from "./tool-dispatcher.ts";

const USER_BASH_JOB_KIND = "user.bash";

function chunkOf(update: unknown): Buffer | undefined {
	if (typeof update !== "object" || update === null) return undefined;
	const data = Reflect.get(update, "data");
	return typeof data === "string" ? Buffer.from(data, "base64") : undefined;
}

function exitCodeOf(value: unknown): number | null {
	if (typeof value !== "object" || value === null) return null;
	const exitCode = Reflect.get(value, "exitCode");
	return typeof exitCode === "number" ? exitCode : null;
}

export function childBashOperations(runner: ToolChildKindRunner, options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, redactSecretsInOutput }) => {
			if (signal?.aborted) throw new Error("aborted");
			const shellEnv: Record<string, string> = {};
			for (const [name, value] of Object.entries(env ?? getShellEnv()))
				if (typeof value === "string") shellEnv[name] = value;
			const { value } = await runner(
				USER_BASH_JOB_KIND,
				{
					command,
					cwd,
					env: shellEnv,
					redactSecretsInOutput: redactSecretsInOutput === true,
					...(options?.shellPath === undefined ? {} : { shellPath: options.shellPath }),
					...(timeout === undefined || timeout <= 0 ? {} : { timeoutSeconds: timeout }),
				},
				{
					toolCallId: `user-bash-${randomUUID()}`,
					signal,
					onUpdate: (update) => {
						const chunk = chunkOf(update);
						if (chunk !== undefined) {
							const stream = Reflect.get(update as object, "stream");
							onData(chunk, stream === "stderr" ? "stderr" : "stdout");
						}
					},
				},
			);
			return { exitCode: exitCodeOf(value) };
		},
	};
}
