import type { ChildProcess } from "node:child_process";
import { createReadStream, fstatSync, write } from "node:fs";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { attachJsonlLineReader } from "./jsonl.ts";

export const MCP_PRESENTER_BOOTSTRAP_FD = 4;

/** The descriptor is not authority: only this live channel's enrollment transcript can issue grants. */
export function presenterBootstrapStream(fd: number): Duplex | undefined {
	if (fd !== MCP_PRESENTER_BOOTSTRAP_FD) return undefined;
	try {
		const stat = fstatSync(fd);
		if (!stat.isSocket() && !stat.isFIFO()) return undefined;
		// Node's fs read blocks a worker until peer EOF, even after destroy(), and process.exit()
		// joins that worker. A socket handle can cancel the pending read after enrollment.
		// Bun does not support inherited net.Socket fds; it retains the file-stream adapter below.
		if (stat.isSocket() && !process.versions.bun) return new Socket({ fd, readable: true, writable: true });
	} catch {
		// Bootstrap is optional authority, never a reason to terminate the shared host.
		return undefined;
	}
	// One stream owns the descriptor. Separate read/write stream destructors can close it twice.
	const input = createReadStream("", { fd, autoClose: true });
	const stream = new Duplex({
		read() {
			input.resume();
		},
		write(chunk: Buffer, _encoding, done) {
			if (chunk.length === 0) {
				done();
				return;
			}
			const send = (offset: number) => {
				write(fd, chunk, offset, chunk.length - offset, null, (error, count) => {
					if (error) done(error);
					else if (count === 0) done(new Error("presenter_bootstrap_write_failed"));
					else if (offset + count === chunk.length) done();
					else send(offset + count);
				});
			};
			send(0);
		},
		destroy(error, done) {
			if (input.closed) done(error);
			else {
				input.once("close", () => done(error));
				input.destroy();
			}
		},
	});
	input.on("data", (chunk) => {
		if (!stream.push(chunk)) input.pause();
	});
	input.on("end", () => stream.push(null));
	input.on("error", (error) => stream.destroy(error));
	return stream;
}

/** Relay one bounded enrollment exchange; fd 3 and stdin are never touched. */
export function relayPresenterBootstrap(upstream: Duplex, child: ChildProcess): Promise<void> {
	const downstream = child.stdio[MCP_PRESENTER_BOOTSTRAP_FD];
	if (!(downstream instanceof Socket)) {
		upstream.destroy();
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		let ended = false;
		let acknowledging = false;
		const finish = () => {
			if (ended) return;
			ended = true;
			clearTimeout(timer);
			unreadUp();
			unreadDown();
			upstream.destroy();
			downstream.destroy();
			resolve();
		};
		const timer = setTimeout(finish, 30_000);
		const unreadUp = attachJsonlLineReader(
			upstream,
			(line) => {
				if (!downstream.write(`${line}\n`)) finish();
			},
			{ maxLineLength: 16 * 1024, onOversizedLine: finish },
		);
		const unreadDown = attachJsonlLineReader(
			downstream,
			(line) => {
				try {
					const record: unknown = JSON.parse(line);
					acknowledging =
						typeof record === "object" && record !== null && "type" in record && record.type === "enrolled";
					upstream.write(`${line}\n`, () => {
						if (acknowledging) finish();
					});
				} catch {
					finish();
				}
			},
			{ maxLineLength: 16 * 1024, onOversizedLine: finish },
		);
		upstream.once("error", finish);
		downstream.once("error", finish);
		upstream.once("end", finish);
		downstream.once("end", () => {
			if (!acknowledging) finish();
		});
		child.once("exit", finish);
	});
}
