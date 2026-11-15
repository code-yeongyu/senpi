import { encodeUtf8 } from "./encoding.ts";
import { type FullOutput, joinHeadAndTail, type OutputSpillFactory } from "./output-accumulator-core.ts";
import type { ToolMachine } from "./tool-machine.ts";

function randomHex(bytes: number): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

/**
 * Spills to a file on the tool machine, so the path a truncation notice names is one the model can read there.
 * Chunks are written in order at their byte offsets as they arrive. The operation layer has no delete, so `remove`
 * empties the file instead.
 */
export function createMachineOutputSpill(machine: ToolMachine, options?: { tempDir?: string }): OutputSpillFactory {
	const tempDir = options?.tempDir ?? "/tmp";
	return (prefix) => {
		const path = `${tempDir}/${prefix}-${randomHex(8)}.log`;
		const ctx = machine.context(undefined);
		let size = 0;
		let writeFailed = false;
		let writeError: unknown;
		let written: Promise<void> = Promise.resolve();
		const read = (offset: number, limitBytes: number) =>
			machine.ops.files.read({ path, offset, limitBytes }, ctx).then((result) => result.bytes);
		return {
			path,
			write: (chunk) => {
				const bytes = typeof chunk === "string" ? encodeUtf8(chunk) : chunk;
				const offset = size;
				size += bytes.length;
				written = written.then(async () => {
					if (writeFailed) return;
					try {
						await machine.ops.files.write({ path, bytes, offset, createParentDirs: true }, ctx);
					} catch (error) {
						writeFailed = true;
						writeError = error;
					}
				});
			},
			close: async () => {
				await written;
				if (writeFailed) throw writeError;
			},
			remove: async () => {
				await written;
				await machine.ops.files.write({ path, bytes: new Uint8Array() }, ctx);
			},
			readFull: async (maxBytes): Promise<FullOutput> => {
				if (size <= maxBytes) {
					return { content: new TextDecoder().decode(await read(0, size)), truncated: false };
				}
				const headBytes = Math.floor(maxBytes / 2);
				const tailBytes = maxBytes - headBytes;
				const [head, tail] = await Promise.all([read(0, headBytes), read(size - tailBytes, tailBytes)]);
				return { content: joinHeadAndTail(head, tail, size - headBytes - tailBytes), truncated: true };
			},
		};
	};
}
