import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";

export const kernels = new Set<JavaScriptKernel>();
const tempRoots = new Set<string>();

export async function trackedTempRoot(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.add(root);
	return root;
}

// Kernel close awaits its child's termination. Remove cwd fixtures only after that signal.
export async function closeProcessFixtures(): Promise<void> {
	for (const kernel of kernels) {
		await kernel.close();
		kernels.delete(kernel);
	}
	for (const root of tempRoots) {
		await rm(root, { recursive: true, force: true, maxRetries: 3 });
		tempRoots.delete(root);
	}
}

afterEach(closeProcessFixtures, 30_000);
