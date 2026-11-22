import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { spawnInternalProcess, terminateInternalProcess } from "../../../src/experimental/process.ts";

const gateEntryUrl = new URL("../../fixtures/coordinator-listen-gate.ts", import.meta.url);

function connectOnce(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("error", (error) => {
			socket.destroy();
			reject(error);
		});
	});
}

function nextLine(socket: Socket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let buffered = "";
		const onData = (chunk: string): void => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			socket.off("data", onData);
			socket.off("close", onClose);
			resolve(JSON.parse(buffered.slice(0, newline)));
		};
		const onClose = (): void => reject(new Error("gate closed before a line arrived"));
		socket.on("data", onData);
		socket.once("close", onClose);
	});
}

// senpi#5185: ensureCoordinator() treats "the control socket accepts" as "ready", so startServer()
// returned a public socket path that was not listening yet and a client connecting at once got
// `connect ENOENT`. The control socket must be published last.
test("coordinator listens on its public socket before publishing the control socket that signals readiness", async ({
	onTestFinished,
}) => {
	const directory = await mkdtemp(join("/tmp", "coord-gate-"));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const publicPath = join(directory, "public.sock");
	const controlPath = join(directory, "control.sock");
	const gatePath = join(directory, "gate.sock");
	let acceptGate!: (socket: Socket) => void;
	const gateSocket = new Promise<Socket>((resolve) => {
		acceptGate = resolve;
	});
	const gate = createServer((socket) => {
		socket.setEncoding("utf8");
		acceptGate(socket);
	});
	await new Promise<void>((resolve) => gate.listen(gatePath, resolve));
	onTestFinished(() => new Promise<void>((resolve) => gate.close(() => resolve())));

	const child = spawnInternalProcess("coordinator", [publicPath, controlPath], {
		entryUrl: gateEntryUrl,
		env: { SENPI_TEST_COORDINATOR_GATE: gatePath },
	});
	onTestFinished(() => terminateInternalProcess(child));
	const childExited = new Promise<never>((_, reject) => {
		child.once("exit", (code, signal) => reject(new Error(`coordinator exited early: ${code ?? signal}`)));
	});

	const socket = await Promise.race([gateSocket, childExited]);
	const held = await Promise.race([nextLine(socket), childExited]);

	// Frozen between the two publications: the public socket must already accept connections,
	// while the readiness (control) socket must not exist yet.
	await connectOnce(publicPath);
	expect(held).toEqual({ held: controlPath });
	await expect(connectOnce(controlPath)).rejects.toMatchObject({ code: "ENOENT" });

	const listening = nextLine(socket);
	socket.write("release\n");
	await expect(Promise.race([listening, childExited])).resolves.toEqual({ listening: controlPath });
	await connectOnce(controlPath);
});
