/**
 * Fixture for test/suite/no-sync-on-move-path.test.ts: the non-import aliasing forms people actually write, one
 * function each. The audit must resolve every call back to its declaration in `node:fs`.
 *
 * Nothing imports this file at runtime.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";

export function fixtureDestructured(from: string, to: string): void {
	const { copyFileSync } = fs;
	copyFileSync(from, to);
}

export function fixtureRenamed(path: string): string {
	const localRead = fs.readFileSync;
	return localRead(path, "utf-8");
}

export function fixtureBoundOrCalled(path: string): boolean {
	const boundStat = fs.statSync.bind(fs);
	return boundStat(path).isFile() && fs.existsSync.call(fs, path);
}

export function fixtureRequired(path: string): void {
	createRequire(import.meta.url)("node:fs").mkdirSync(path, { recursive: true });
}
