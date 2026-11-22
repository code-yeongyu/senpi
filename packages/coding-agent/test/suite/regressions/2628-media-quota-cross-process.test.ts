import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MAX_SESSION_MEDIA_BYTES, persistToolImage, toolMediaRoot } from "../../../src/modes/rpc/tool-media-store.ts";

const SESSION_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
const IMAGE_BYTES = 64;
const childFile = fileURLToPath(new URL("./2628-media-quota-writer.ts", import.meta.url));

async function request(child: ChildProcess, name: string): Promise<unknown> {
	const reply = once(child, "message", { signal: AbortSignal.timeout(5000) });
	child.send(name);
	const [value]: unknown[] = await reply;
	return value;
}

// senpi#2628: two live hosts must agree on what one durable session has left.
it("does not let two live media writers together exceed the durable session cap", async () => {
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-media-quota-"));
	const root = toolMediaRoot({ sessionDir, durableSessionId: SESSION_ID });
	const children = new Map<number, { child: ChildProcess; closed: Promise<unknown> }>();
	try {
		const seedDir = join(root, "previous-call");
		await mkdir(seedDir, { recursive: true });
		await using seed = await open(join(seedDir, "seed.png"), "w");
		await seed.truncate(MAX_SESSION_MEDIA_BYTES - 3 * IMAGE_BYTES);

		const start = (writer: string): ChildProcess => {
			const child = fork(childFile, [sessionDir, SESSION_ID, writer], { execPath: "bun", execArgv: [] });
			if (child.pid === undefined) throw new Error(`Couldn't start writer ${writer}`);
			children.set(child.pid, { child, closed: once(child, "close") });
			return child;
		};
		const left = start("left");
		const right = start("right");
		expect(await request(left, "warm")).toHaveProperty("path");
		expect(await request(right, "warm")).toHaveProperty("path");

		const outcomes = await Promise.all([request(left, "last"), request(right, "last")]);
		const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
		let total = 0;
		for (const file of files) total += (await stat(join(file.parentPath, file.name))).size;

		expect(total).toBe(MAX_SESSION_MEDIA_BYTES);
		expect(outcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: expect.any(String) }),
				{ unavailableReason: "session_limit" },
			]),
		);
	} finally {
		for (const { child, closed } of children.values()) {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await closed;
		}
		await rm(sessionDir, { recursive: true, force: true });
	}
});

// senpi#2628: the first image request must let the host service an event-loop turn.
it("lets an event-loop turn run while the cold media directory is being measured", async () => {
	const sessionDir = await mkdtemp(join(tmpdir(), "senpi-media-cold-"));
	const scope = { sessionDir, durableSessionId: SESSION_ID };
	try {
		const previous = join(toolMediaRoot(scope), "previous-call");
		await mkdir(previous, { recursive: true });
		for (let i = 0; i < 512; i++) await writeFile(join(previous, `${i}.png`), "seed");
		const bytes = Buffer.alloc(4 * 1024 * 1024);
		Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
		const block = { data: bytes.toString("base64"), mimeType: "image/png" };

		let serviced = false;
		const heartbeat = setImmediate().then(() => {
			serviced = true;
		});
		const written = await persistToolImage(scope, { toolCallId: "cold", contentIndex: 0 }, block);
		const servicedBeforeWrite = serviced;
		await heartbeat;

		expect(written).toHaveProperty("path");
		expect(servicedBeforeWrite).toBe(true);
	} finally {
		await rm(sessionDir, { recursive: true, force: true });
	}
});
