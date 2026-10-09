import { describe, expect, it } from "vitest";
import { marshalToolResult, toolResultIsError } from "../src/tool/image.ts";
import {
	catchCode,
	create,
	handle,
	inspectById,
	listedTools,
	mistypedTools,
	omittedMode,
	operations,
	setup,
	showCreated,
} from "./workpool/cells.ts";
import {
	agentSpec,
	availability,
	displayedPoolId,
	fixture,
	hostResult,
	items,
	languages,
	poolId,
	receipt,
	record,
	retainingHost,
} from "./workpool/fixture.ts";

for (const language of languages) {
	if (process.env.SENPI_QA_REQUIRE_ALL_LANGUAGES === "1" && !availability[language].detected.ok) {
		throw new Error(`Required workpool interpreter unavailable: ${language}`);
	}
	describe.skipIf(!availability[language].detected.ok)(`${language} workpool prelude`, () => {
		it("forwards the host machine contract and keeps only an opaque ID", async () => {
			// Given: responses come from the host, not prelude scheduling.
			const calls: Array<{ name: string; args: unknown }> = [];
			const f = await fixture(async (name, args) => {
				calls.push({ name, args });
				return hostResult(
					typeof args === "object" && args !== null && "op" in args && args.op === "push" ? receipt : record,
				);
			});
			try {
				// When
				const result = await f.run(language, [setup[language], create[language], operations[language]].join("\n"));
				// Then
				expect(toolResultIsError(result), JSON.stringify(result)).toBe(false);
				expect(calls).toEqual([
					{ name: "workpool", args: { op: "create", name: "batch", agent: agentSpec, mode: "fresh" } },
					{ name: "workpool", args: { op: "push", pool_id: poolId, items } },
					...(["inspect", "close", "cancel"] as const).map((op) => ({
						name: "workpool",
						args: { op, pool_id: poolId },
					})),
				]);
				expect(result.details.jsonOutputs).toEqual([
					{
						pool_id: poolId,
						push: marshalToolResult(hostResult(receipt)),
						inspect: marshalToolResult(hostResult(record)),
						close: marshalToolResult(hostResult(record)),
						cancel: marshalToolResult(hostResult(record)),
					},
				]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("leaves an omitted mode to the engine", async () => {
			const calls: unknown[] = [];
			const f = await fixture(async (_name, args) => {
				calls.push(args);
				return hostResult(record);
			});
			try {
				const result = await f.run(language, `${setup[language]}\n${omittedMode[language]}`);
				expect(toolResultIsError(result), JSON.stringify(result)).toBe(false);
				expect(calls).toEqual([{ op: "create", agent: agentSpec, name: "default" }]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("can inspect by ID and recreate an adapter after a real kernel reset", async () => {
			const { executeTool } = retainingHost();
			const f = await fixture(executeTool);
			try {
				const created = await f.run(language, `${setup[language]}\n${create[language]}\n${showCreated[language]}`);
				expect(toolResultIsError(created)).toBe(false);
				const createdId = displayedPoolId(created);
				const afterReset = await f.run(language, inspectById(language, createdId), true);
				expect(toolResultIsError(afterReset)).toBe(false);
				expect(afterReset.details.jsonOutputs).toEqual([
					{ inspection: marshalToolResult(hostResult({ ...record, pool_id: createdId })) },
				]);
				const recreated = await f.run(language, `${setup[language]}\n${create[language]}\n${operations[language]}`);
				expect(toolResultIsError(recreated), JSON.stringify(recreated)).toBe(false);
			} finally {
				await f.manager.dispose();
			}
		});

		it.each(["unknown_tool", "inactive_tool"])("returns typed unavailable for %s", async (code) => {
			const f = await fixture(async () => {
				throw Object.assign(new Error("fixture unavailable"), { code });
			});
			try {
				const result = await f.run(language, `${setup[language]}\n${catchCode(language, create[language])}`);
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([{ code: "workpool_unavailable" }]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("refuses tools given as a single string with a typed error, and posts nothing to the host", async () => {
			const calls: unknown[] = [];
			const f = await fixture(async (_name, args) => {
				calls.push(args);
				return hostResult(record);
			});
			try {
				const result = await f.run(language, `${setup[language]}\n${catchCode(language, mistypedTools[language])}`);
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([{ code: "invalid_tools" }]);
				expect(calls).toEqual([]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("forwards a list of tool names unchanged", async () => {
			const calls: unknown[] = [];
			const f = await fixture(async (_name, args) => {
				calls.push(args);
				return hostResult(record);
			});
			try {
				const result = await f.run(language, `${setup[language]}\n${listedTools[language]}`);
				expect(toolResultIsError(result), JSON.stringify(result)).toBe(false);
				expect(calls).toEqual([{ op: "create", agent: agentSpec, name: "listed", tools: ["add", "mul"] }]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("preserves a typed create refusal instead of returning a broken adapter", async () => {
			const f = await fixture(async () =>
				hostResult({ isError: true, error: { code: "scope_denied", message: "Different parent" } }),
			);
			try {
				const result = await f.run(language, `${setup[language]}\n${catchCode(language, create[language])}`);
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([{ code: "scope_denied" }]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("returns the authoritative task epoch through the real bridge", async () => {
			const f = await fixture(async () => hostResult({ task_id: "st_abcdef", run_epoch: 2 }));
			try {
				const result = await f.run(language, handle[language]);
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([
					expect.objectContaining({ id: "st_abcdef", handle: "agent://st_abcdef", run_epoch: 2 }),
				]);
			} finally {
				await f.manager.dispose();
			}
		});

		// senpi#1910: exercise the real JS and HTTP reserved bridges, including Python string modes.
		it.each(["patch", "branch"])("forwards isolation merge mode %s through agent()", async (merge) => {
			const calls: unknown[] = [];
			const f = await fixture(
				async (_name, args) => {
					calls.push(args);
					return hostResult({ isolation: { changes_applied: true } });
				},
				() => [{ name: "task", parameters: { properties: { isolated: { type: "boolean" } } } }],
			);
			const code = {
				js: `await agent('fixture', { isolated: true, apply: false, merge: '${merge}' });`,
				py: `agent('fixture', isolated=True, apply=False, merge='${merge}')`,
				rb: `agent('fixture', isolated: true, apply: false, merge: '${merge}')`,
				jl: `agent("fixture", isolated=true, apply=false, merge="${merge}")`,
			};
			try {
				const result = await f.run(language, code[language]);
				expect(toolResultIsError(result), JSON.stringify(result)).toBe(false);
				expect(calls).toEqual([
					expect.objectContaining({ isolated: true, apply: false, merge, run_in_background: false }),
				]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("keeps isolation failure machine-readable across the transport", async () => {
			const f = await fixture(async () =>
				hostResult({ isolation: { changes_applied: false, patch_path: "/artifacts/task.patch" } }),
			);
			const code = {
				js: "await agent('fixture');",
				py: "agent('fixture')",
				rb: "agent('fixture')",
				jl: 'agent("fixture")',
			};
			try {
				const result = await f.run(language, catchCode(language, code[language]));
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([{ code: "isolation_not_applied" }]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("preserves optional host isolation on handles without waiting for completion", async () => {
			const isolation = { changes_applied: false, patch_path: "/artifacts/task.patch" };
			const f = await fixture(async () => hostResult({ task_id: "st_abcdef", run_epoch: 2, isolation }));
			try {
				const result = await f.run(language, handle[language]);
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([
					expect.objectContaining({ id: "st_abcdef", run_epoch: 2, details: { isolation } }),
				]);
			} finally {
				await f.manager.dispose();
			}
		});

		it("keeps invalid_task_handle machine-readable across the transport", async () => {
			const f = await fixture(async () => hostResult({ task_id: "st_abcdef" }));
			try {
				const result = await f.run(language, catchCode(language, handle[language]));
				expect(result.details.jsonOutputs, JSON.stringify(result)).toEqual([{ code: "invalid_task_handle" }]);
			} finally {
				await f.manager.dispose();
			}
		});
	});
}
