#!/usr/bin/env node

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishPackage } from "./publish-command.mjs";

const pkg = { name: "@code-yeongyu/senpi", version: "2026.11.19-5" };
const stagedConflict = new Error(
	'Command failed: npm publish\nnpm error code E409\nnpm error 409 Conflict - PUT ... - Cannot publish over previously staged version "2026.11.19-5".',
);
const publishConflict = new Error("Command failed: npm publish\nnpm ERR! code EPUBLISHCONFLICT");

// senpi#1831: the registry can report absence before the PUT and visibility after it.
describe("npm publish conflict recovery", () => {
	for (const [code, conflict] of [["E409", stagedConflict], ["EPUBLISHCONFLICT", publishConflict]]) {
		it(`continues after ${code} when the exact version is visible, without another PUT`, () => {
			let publishAttempts = 0;
			const outcome = publishPackage(
				pkg,
				() => {
					publishAttempts += 1;
					throw conflict;
				},
				(spec) => (spec === "@code-yeongyu/senpi@2026.11.19-5" ? "2026.11.19-5" : null),
			);
			assert.equal(outcome, "already-published");
			assert.equal(publishAttempts, 1);
		});
	}

	for (const [reason, readVersion] of [
		["the requested version is absent", () => null],
		["only a different version is visible", () => "2026.11.19-4"],
		[
			"the registry cannot be read",
			() => {
				throw new Error("npm view timed out");
			},
		],
	]) {
		it(`rethrows the original publish conflict when ${reason}`, () => {
			assert.throws(
				() =>
					publishPackage(
						pkg,
						() => {
							throw stagedConflict;
						},
						readVersion,
					),
				(error) => error === stagedConflict,
			);
		});
	}

	for (const [code, errorLine] of [["E403", "Forbidden"], ["E409", "Unexpected conflict"]]) {
		it(`does not read the registry for ${code}: ${errorLine}`, () => {
			const failure = new Error(`Command failed: npm publish\nnpm error code ${code}\nnpm error ${errorLine}`);
			let registryReads = 0;
			assert.throws(
				() =>
					publishPackage(
						pkg,
						() => {
							throw failure;
						},
						() => {
							registryReads += 1;
							return pkg.version;
						},
					),
				(error) => error === failure,
			);
			assert.equal(registryReads, 0);
		});
	}
});
