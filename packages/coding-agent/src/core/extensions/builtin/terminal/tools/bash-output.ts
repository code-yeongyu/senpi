import { type Static, Type } from "typebox";
import type { AgentToolUpdateCallback } from "../../../types.ts";
import { formatTerminalToolOutput } from "../output-format.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import { DEFAULT_OUTPUT_WAIT_TIMEOUT_SECONDS, safeRegExp, TERMINAL_OUTPUT_TOOL } from "../shared.ts";
import { createThrottledEmitter } from "./bash.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { renderBashOutputCall, renderBashOutputResult } from "./render.ts";
import { describeExit } from "./spawn.ts";

const MAX_OUTPUT_WAIT_TIMEOUT_SECONDS = 300;
const STREAM_PREVIEW_MAX_BYTES = 64 * 1024;

function truncateTailBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

class TailBuffer {
	readonly #maxBytes: number;
	#text = "";
	#bytes = 0;

	constructor(maxBytes: number) {
		this.#maxBytes = Math.max(0, Math.floor(maxBytes));
	}

	append(text: string): void {
		if (text.length === 0) return;
		if (this.#maxBytes === 0) {
			this.#text = "";
			this.#bytes = 0;
			return;
		}
		const incomingBytes = Buffer.byteLength(text, "utf8");
		this.#text =
			incomingBytes >= this.#maxBytes
				? truncateTailBytes(text, this.#maxBytes)
				: truncateTailBytes(this.#text + text, this.#maxBytes);
		this.#bytes = Buffer.byteLength(this.#text, "utf8");
	}

	text(): string {
		return this.#text;
	}

	bytes(): number {
		return this.#bytes;
	}
}

export const bashOutputSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	filter: Type.Optional(Type.String({ description: "Only return output lines matching this regex." })),
	wait_for: Type.Optional(
		Type.String({ description: "Block until output matches this regex, the session exits, or timeout." }),
	),
	block: Type.Optional(Type.Boolean({ description: "When wait_for is set, block (default true)." })),
	timeout: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: MAX_OUTPUT_WAIT_TIMEOUT_SECONDS,
			description: "wait_for timeout in seconds (default 30, maximum 300).",
		}),
	),
	view: Type.Optional(
		Type.Union([Type.Literal("log"), Type.Literal("screen")], {
			description: "'log' returns new raw output (default); 'screen' returns the rendered xterm grid.",
		}),
	),
});

export type BashOutputInput = Static<typeof bashOutputSchema>;

function statusLine(runtime: TerminalRuntimeSession): string {
	if (!runtime.exited) return "status: running";
	const status = describeExit(runtime) ?? "exited";
	const code = runtime.exitResult?.exitCode;
	return code === null || code === undefined ? `status: ${status}` : `status: ${status} exit_code: ${code}`;
}

function applyFilter(text: string, filter: string | undefined): string {
	if (!filter) return text;
	const regex = safeRegExp(filter);
	if (regex === null) return text;
	return text
		.split("\n")
		.filter((line) => regex.test(line))
		.join("\n");
}

function screenView(runtime: TerminalRuntimeSession): string {
	const snapshot = runtime.snapshot();
	return snapshot.visibleGrid.join("\n").replace(/\s+$/, "");
}

export function createBashOutputTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_OUTPUT_TOOL,
		label: "bash_output",
		description:
			"Read new output from a background bash session, or block until wait_for matches / the session exits / timeout. Use view:'screen' for a rendered full-screen snapshot.",
		promptSnippet: "Read/subscribe to background bash session output (wait_for, filter, screen view)",
		parameters: bashOutputSchema,
		async execute(
			_toolCallId: string,
			input: BashOutputInput,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<Record<string, unknown> | undefined>,
		): Promise<TerminalToolResult> {
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);

			if (input.wait_for && input.block !== false) {
				const timeoutSeconds = Math.min(
					Math.max(input.timeout ?? DEFAULT_OUTPUT_WAIT_TIMEOUT_SECONDS, 0),
					MAX_OUTPUT_WAIT_TIMEOUT_SECONDS,
				);
				const timeoutMs = Math.trunc(timeoutSeconds * 1000);
				if (input.view === "screen") {
					const outcome = await runtime.waitFor(input.wait_for, timeoutMs, signal);
					if (outcome === "invalid_pattern") return errorResult(`Invalid wait_for regex: ${input.wait_for}`);
				} else {
					const startedAt = Date.now();
					const progress = {
						activity: `waiting for /${input.wait_for}/`,
						startedAt,
						...(input.timeout === undefined ? {} : { maxWaitMs: timeoutMs }),
					};
					const preview = new TailBuffer(STREAM_PREVIEW_MAX_BYTES);
					const emit = () => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `${statusLine(runtime)}\n${formatTerminalToolOutput(applyFilter(preview.text(), input.filter)).text}`,
								},
							],
							details: { progress },
						});
					};
					onUpdate?.({ content: [{ type: "text", text: statusLine(runtime) }], details: { progress } });
					const throttle = createThrottledEmitter(emit);
					const unsubscribe = runtime.onOutput((chunk) => {
						preview.append(chunk);
						throttle.schedule();
					});
					try {
						const outcome = await runtime.waitFor(input.wait_for, timeoutMs, signal);
						if (outcome === "invalid_pattern") return errorResult(`Invalid wait_for regex: ${input.wait_for}`);
					} finally {
						throttle.flush();
						unsubscribe();
						throttle.dispose();
					}
				}
			}

			if (input.view === "screen") {
				return textResult(`${statusLine(runtime)}\n${screenView(runtime)}`);
			}

			const delta = runtime.readDelta();
			const formatted = formatTerminalToolOutput(applyFilter(delta.text, input.filter));
			const dropped = delta.droppedChars > 0 ? `[${delta.droppedChars} earlier chars dropped]\n` : "";
			return textResult(`${statusLine(runtime)}\n${dropped}${formatted.text || "(no new output)"}`);
		},
		renderCall: renderBashOutputCall,
		renderResult: renderBashOutputResult,
	};
}
