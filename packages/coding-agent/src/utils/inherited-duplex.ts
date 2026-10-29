import { createReadStream, fstatSync, write } from "node:fs";
import { Socket } from "node:net";
import { Duplex } from "node:stream";

/** One stream owns a verified inherited pipe/socket, including Bun's file-stream adoption path. */
export function inheritedDuplex(fd: number): Duplex | undefined {
	try {
		const stat = fstatSync(fd);
		if (!stat.isSocket() && !stat.isFIFO()) return undefined;
		if (stat.isSocket() && !process.versions.bun) return new Socket({ fd, readable: true, writable: true });
	} catch {
		return undefined;
	}
	const input = createReadStream("", { fd, autoClose: true });
	const stream = new Duplex({
		read() {
			input.resume();
		},
		write(chunk: Buffer, _encoding, done) {
			if (chunk.length === 0) return done();
			const send = (offset: number) => {
				write(fd, chunk, offset, chunk.length - offset, null, (error, count) => {
					if (error) done(error);
					else if (count === 0) done(new Error("private_channel_write_failed"));
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
