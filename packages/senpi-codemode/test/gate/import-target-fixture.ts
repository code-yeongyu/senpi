import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createTarget(root: string): Promise<string> {
	const target = join(root, "packages/senpi-codemode");
	await mkdir(join(target, "src/extension"), { recursive: true });
	await mkdir(join(target, "src/config"), { recursive: true });
	await mkdir(join(target, "src/interpreters"), { recursive: true });
	await writeFile(join(root, "package.json"), '{"type":"module"}');
	await mkdir(join(root, "packages/coding-agent/src/core/extensions"), { recursive: true });
	await writeFile(
		join(root, "packages/coding-agent/src/core/extensions/loader.ts"),
		'import * as box from "typebox"; const VIRTUAL_MODULES = { typebox: box };',
	);
	await writeFile(
		join(root, "packages/coding-agent/src/core/extensions/virtual-modules.ts"),
		'import * as box from "typebox"; export const VIRTUAL_MODULES = { typebox: box };',
	);
	await writeFile(
		join(target, "src/index.ts"),
		'import { Type } from "typebox"; export const schema = Type.String();',
	);
	await writeFile(join(target, "src/config/settings.ts"), "export const defaultCodemodeSettings = {};");
	await writeFile(
		join(target, "src/interpreters/detect.ts"),
		"export const createInterpreterDetector = () => ({}); export const getInterpreterAvailability = async () => ({});",
	);
	await writeFile(
		join(target, "src/extension/worker.ts"),
		'import { parentPort } from "node:worker_threads"; import { basename } from "node:path"; parentPort.postMessage(basename("/fixture/ready"));',
	);
	await writeFile(
		join(target, "src/extension/session-manager.ts"),
		`
import { Worker } from "node:worker_threads";
import { once } from "node:events";
export async function createCodemodeSessionManager() {
	let worker;
	return {
		getKernel: async () => ({
			run: async () => {
				worker = new Worker(new URL("./worker.ts", import.meta.url));
				await once(worker, "message");
				return { ok: true };
			},
		}),
		dispose: async () => { await worker?.terminate(); },
	};
}`,
	);
	return target;
}
