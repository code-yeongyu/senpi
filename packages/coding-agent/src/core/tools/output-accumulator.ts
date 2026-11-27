import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { openToolFile } from "@code-yeongyu/senpi-machine-ops";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OutputAccumulator as CoreOutputAccumulator,
	type OutputAccumulatorOptions,
	type OutputSpill,
	type OutputSpillFactory,
	joinHeadAndTail,
} from "./output-accumulator-core.ts";

export type { FullOutput, OutputAccumulatorOptions, OutputSnapshot } from "./output-accumulator-core.ts";

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function destroyStream(stream: WriteStream): Promise<void> {
	return new Promise<void>((resolve) => {
		if (stream.closed) {
			resolve();
			return;
		}
		stream.once("close", resolve);
		stream.destroy();
	});
}

function endStream(stream: WriteStream): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let finished = false;
		let closed = false;
		let streamError: Error | undefined;
		const settle = () => {
			if (!closed) {
				return;
			}
			stream.off("finish", onFinish);
			stream.off("error", onError);
			stream.off("close", onClose);
			if (streamError) {
				reject(streamError);
			} else if (finished) {
				resolve();
			} else {
				reject(new Error("Output spill stream closed before finish"));
			}
		};
		const onError = (error: Error) => {
			streamError ??= error;
		};
		const onFinish = () => {
			finished = true;
		};
		const onClose = () => {
			closed = true;
			if (!finished && !stream.destroyed) {
				stream.destroy();
			}
			settle();
		};
		stream.once("error", onError);
		stream.once("finish", onFinish);
		stream.once("close", onClose);
		stream.end();
	});
}

async function readTempFile(path: string, maxBytes: number) {
	const file = await openToolFile(path);
	try {
		const size = (await file.stat()).size;
		if (size <= maxBytes) {
			return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
		}
		const headBytes = Math.floor(maxBytes / 2);
		const tailBytes = maxBytes - headBytes;
		const head = Buffer.alloc(headBytes);
		const tail = Buffer.alloc(tailBytes);
		await file.read(head, 0, headBytes, 0);
		await file.read(tail, 0, tailBytes, size - tailBytes);
		return { content: joinHeadAndTail(head, tail, size - headBytes - tailBytes), truncated: true };
	} finally {
		await file.close();
	}
}

/** The local spill: a temp file under the OS temp directory, streamed as output arrives. */
export const createTempFileSpill: OutputSpillFactory = (prefix): OutputSpill => {
	const path = defaultTempFilePath(prefix);
	const stream = createWriteStream(path);
	let writeError: Error | undefined;
	stream.on("error", (error) => {
		writeError ??= error;
	});
	return {
		path,
		write: (chunk) => {
			stream.write(chunk);
		},
		close: async () => {
			if (writeError) {
				await destroyStream(stream);
				throw writeError;
			}
			await endStream(stream);
		},
		remove: () => rm(path, { force: true }),
		readFull: (maxBytes) => readTempFile(path, maxBytes),
	};
};

/** The output accumulator of the local tools: it spills to a temp file unless the caller supplies a spill. */
export class OutputAccumulator extends CoreOutputAccumulator {
	constructor(options: OutputAccumulatorOptions & { spill?: OutputSpillFactory } = {}) {
		super({ ...options, spill: options.spill ?? createTempFileSpill });
	}
}
