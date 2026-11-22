import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { BashToolDetails } from "./bash-schema.ts";
import { modelOnlyText } from "./model-only-text.ts";
import type { OutputAccumulator, OutputSnapshot } from "./output-accumulator-core.ts";
import { SecretOutputRedactor } from "./secret-output-redactor.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

const BASH_UPDATE_THROTTLE_MS = 100;

export interface FormattedShellOutput {
	text: string;
	content: TextContent[];
	details: BashToolDetails | undefined;
}

/**
 * One shell run's output stream: optional secret redaction per stream, throttled partial updates, and the terminal
 * flush that settles the spill before the result is built.
 */
export function createShellOutput(
	output: OutputAccumulator,
	onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
	redactSecretsInOutput: boolean,
) {
	const streams = redactSecretsInOutput
		? new Map<string, { redactor: SecretOutputRedactor; decoder: TextDecoder }>()
		: undefined;
	let acceptingOutput = true;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;
	let outputUpdateError: unknown;
	let hasOutputUpdateError = false;

	const emitOutputUpdate = () => {
		if (!onUpdate || !updateDirty || hasOutputUpdateError) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		try {
			onUpdate({
				content: [{ type: "text", text: snapshot.content || "" }],
				details: {
					truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
					fullOutputPath: snapshot.fullOutputPath,
				},
			});
		} catch (error) {
			outputUpdateError = error;
			hasOutputUpdateError = true;
		}
	};

	const clearUpdateTimer = () => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
	};

	const scheduleOutputUpdate = () => {
		if (!onUpdate) return;
		updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitOutputUpdate();
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			emitOutputUpdate();
		}, delay);
	};

	const handleData = (data: Uint8Array, stream = "stdout") => {
		if (!acceptingOutput) return;
		if (streams) {
			let state = streams.get(stream);
			if (!state) {
				state = { redactor: new SecretOutputRedactor(), decoder: new TextDecoder() };
				streams.set(stream, state);
			}
			output.appendText(state.redactor.push(state.decoder.decode(data, { stream: true })));
		} else output.append(data);
		scheduleOutputUpdate();
	};

	const finishOutput = async (): Promise<OutputSnapshot> => {
		acceptingOutput = false;
		clearUpdateTimer();
		let primaryError: unknown;
		let hasPrimaryError = false;
		let snapshot: OutputSnapshot | undefined;
		try {
			if (streams) {
				for (const { redactor, decoder } of streams.values()) {
					output.appendText(redactor.push(decoder.decode()) + redactor.finish());
				}
				updateDirty = true;
			}
			output.finish();
			emitOutputUpdate();
			snapshot = output.snapshot({ persistIfTruncated: true });
			if (hasOutputUpdateError) {
				primaryError = outputUpdateError;
				hasPrimaryError = true;
			}
		} catch (error) {
			primaryError = error;
			hasPrimaryError = true;
		}
		try {
			await output.closeTempFile();
		} catch (closeError) {
			if (hasPrimaryError) {
				throw new AggregateError([primaryError, closeError], "Bash output finalization and spill cleanup failed");
			}
			throw closeError;
		}
		if (hasPrimaryError) {
			try {
				await output.removeTempFile();
			} catch (unlinkError) {
				if (!(unlinkError instanceof Error)) throw unlinkError;
				throw new AggregateError([primaryError, unlinkError], "Bash output finalization and spill cleanup failed");
			}
			throw primaryError;
		}
		if (snapshot === undefined) {
			throw new Error("Bash output finalization produced no snapshot");
		}
		return snapshot;
	};

	const formatOutput = (snapshot: OutputSnapshot, emptyText = "(no output)"): FormattedShellOutput => {
		const truncation = snapshot.truncation;
		const text = snapshot.content || emptyText;
		let notice: string | undefined;
		let details: BashToolDetails | undefined;
		if (truncation.truncated) {
			details = { truncation, fullOutputPath: snapshot.fullOutputPath };
			const startLine = truncation.totalLines - truncation.outputLines + 1;
			const endLine = truncation.totalLines;
			if (truncation.lastLinePartial) {
				const lastLineSize = formatSize(output.getLastLineBytes());
				notice = `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
			} else if (truncation.truncatedBy === "lines") {
				notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
			} else {
				notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
			}
		}
		// The empty placeholder is for the model only (senpi#7209): programmatic callers see no text.
		const content: TextContent[] = [
			snapshot.content ? { type: "text", text: notice === undefined ? text : `${text}\n` } : modelOnlyText(text),
		];
		if (notice !== undefined) content.push(modelOnlyText(notice));
		return { text: notice === undefined ? text : `${text}\n\n${notice}`, content, details };
	};

	return { handleData, finishOutput, formatOutput, clearUpdateTimer };
}
