/**
 * The agent's relocation tools against the real RPC connection handler: the engine knows no other machines, so
 * every answer comes from the host over `host_request` / `host_response`. A refusal of any kind leaves the session
 * working here; an accepted request is scheduled for the end of the current turn and never interrupts it.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";
import { getToolResult } from "./harness.ts";
import { heldTurn } from "./rpc-release-host-support.ts";
import {
	type RelocationRig,
	relocationRig,
	runToolTurn,
	stillWritableHere,
	textOf,
	type WireRecord,
} from "./rpc-relocate-session-support.ts";

const rigs: RelocationRig[] = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.cleanup();
});
async function rig(options: Parameters<typeof relocationRig>[0]): Promise<RelocationRig> {
	const created = await relocationRig(options);
	rigs.push(created);
	return created;
}
const OFFERS = ["session_relocation"];
const hostRequests = (records: readonly WireRecord[]) => records.filter((record) => record.type === "host_request");

describe("relocate_session over RPC", () => {
	it("is not offered to the agent where no host offers relocation; a direct call is refused typed", async () => {
		// Given: a connection that never advertised session_relocation (a plain CLI client), after a turn.
		const plain = await rig({});
		plain.harness.setResponses([fauxAssistantMessage("hello")]);
		await plain.harness.session.prompt("hi");
		await plain.harness.session.agent.waitForIdle();

		// When: something calls the tool anyway (a host that left mid-turn ends up here too).
		const runner = plain.harness.getExtensionRunner();
		const tool = runner.getAllRegisteredTools().find((entry) => entry.definition.name === "relocate_session");
		if (!tool) throw new Error("relocate_session is not registered");
		const result = await tool.definition.execute(
			"direct",
			{ target: "Studio", reason: "heavy build" },
			undefined,
			undefined,
			runner.createContext() as ExtensionToolContext,
		);

		// Then: neither tool was ever active for the model; the call is refused typed and nothing was asked of a host.
		expect(plain.harness.session.getActiveToolNames()).not.toContain("relocate_session");
		expect(plain.harness.session.getActiveToolNames()).not.toContain("list_relocation_targets");
		expect(result.details).toMatchObject({ status: "unavailable", reason: "not_offered" });
		expect(textOf(result)).toContain("this computer");
		expect(textOf(result)).not.toMatch(/transfer/i);
		expect(hostRequests(plain.records)).toEqual([]);
		expect(plain.records.some((record) => record.type === "relocation_due")).toBe(false);
		expect(await stillWritableHere(plain)).toBe(true);
	});

	it("passes the host's refusal back typed, and the session stays writable here", async () => {
		// Given: a host that offers relocation but declines this one.
		const declining = await rig({
			capabilities: OFFERS,
			host: () => ({ data: { accepted: false, reason: "target_busy", detail: "Studio is running a build" } }),
		});

		// When: the agent asks to continue on Studio.
		const result = await runToolTurn(declining, "relocate_session", { target: "Studio", reason: "heavy build" });

		// Then: the host saw exactly one relocate request with the agent's words; the refusal comes back typed.
		expect(hostRequests(declining.records)).toEqual([
			expect.objectContaining({ method: "relocate_session", target: "Studio", reason: "heavy build" }),
		]);
		expect(result.details).toMatchObject({ status: "refused", reason: "target_busy" });
		expect(textOf(result)).toContain("Studio is running a build");
		expect(declining.records.some((record) => record.type === "relocation_due")).toBe(false);
		expect(await stillWritableHere(declining)).toBe(true);
	});

	it("round-trips the host-request contract: targets listed, answers acknowledged, strays refused", async () => {
		// Given: a host offering two computers.
		const targets = [
			{ name: "Studio", online: true, capacity: "high", aboutToSleep: false },
			{ name: "Laptop", online: false, aboutToSleep: true },
		];
		const offering = await rig({ capabilities: OFFERS, host: () => ({ data: { targets } }) });

		// When: the agent lists where it could continue, and a stray answer arrives for no request.
		const result = await runToolTurn(offering, "list_relocation_targets", {});
		await offering.handler.handleInputLine(JSON.stringify({ type: "host_response", id: "hr-stray", data: {} }));

		// Then: one tagged request, its answer acknowledged, the targets passed through, the stray refused.
		const [request] = hostRequests(offering.records);
		expect(request).toMatchObject({ method: "list_relocation_targets", sessionId: "rpc-1" });
		expect(typeof request?.id).toBe("string");
		expect(result.details).toEqual({ status: "listed", targets });
		expect(textOf(result)).toContain("Studio");
		expect(offering.replies()).toEqual([
			expect.objectContaining({ id: request?.id, success: true }),
			expect.objectContaining({ id: "hr-stray", success: false, error: "unknown_host_request" }),
		]);
	});

	it("schedules an accepted move for the end of the turn and never interrupts it", async () => {
		// Given: a host that accepts and names the move.
		const accepting = await rig({
			capabilities: OFFERS,
			host: () => ({ data: { accepted: true, moveId: "mv-1", target: "Studio" } }),
		});

		// When: the agent asks to move mid-turn, then writes its closing reply in the same turn.
		const result = await runToolTurn(
			accepting,
			"relocate_session",
			{ target: "Studio", reason: "heavy build" },
			"wrapping up",
		);

		// Then: the tool says the work continues on Studio once this turn ends; the turn ran to its end;
		// exactly one relocation_due follows it, carrying the host's move id.
		expect(result.details).toMatchObject({ status: "scheduled", target: "Studio", moveId: "mv-1" });
		expect(textOf(result)).toContain("Studio");
		expect(textOf(result)).toMatch(/when this turn ends/i);
		expect(accepting.harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		const due = accepting.records.filter((record) => record.type === "relocation_due");
		expect(due).toEqual([expect.objectContaining({ moveId: "mv-1", target: "Studio", sessionId: "rpc-1" })]);
		const dueAt = accepting.records.findIndex((record) => record.type === "relocation_due");
		const lastEnd = accepting.records.findLastIndex((record) => record.type === "agent_end");
		expect(lastEnd).toBeGreaterThan(-1);
		expect(dueAt).toBeGreaterThan(lastEnd);
	});

	it("drops a scheduled move when the user aborts the turn: no relocation_due follows", async () => {
		// Given: an accepted move, and a turn still running after the tool answered.
		const accepting = await rig({
			capabilities: OFFERS,
			host: () => ({ data: { accepted: true, moveId: "mv-1", target: "Studio" } }),
		});
		accepting.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "a" })], {
				stopReason: "toolUse",
			}),
			heldTurn,
		]);
		const scheduled = new Promise<void>((resolve) => {
			const stop = accepting.harness.session.subscribe((event) => {
				if (event.type !== "tool_execution_end" || event.toolName !== "relocate_session") return;
				stop();
				resolve();
			});
		});
		const turn = accepting.harness.session.prompt("move, then keep working");
		await scheduled;

		// When: the user aborts the turn from the client.
		await accepting.handler.handleInputLine(JSON.stringify({ type: "abort", id: "stop" }));
		await turn;
		await accepting.harness.session.agent.waitForIdle();

		// Then: the move was scheduled, but the abort dropped it. A later turn here settles too (a move still
		// scheduled would be announced at that settle), and still nothing tells the host to move.
		expect(getToolResult(accepting.harness, "relocate_session").details).toMatchObject({ status: "scheduled" });
		expect(await stillWritableHere(accepting)).toBe(true);
		expect(accepting.records.some((record) => record.type === "relocation_due")).toBe(false);
	});

	it("refuses a second move while one is already scheduled for this turn", async () => {
		// Given: a host that accepts every request.
		const accepting = await rig({
			capabilities: OFFERS,
			host: () => ({ data: { accepted: true, moveId: "mv-1", target: "Studio" } }),
		});

		// When: the agent asks twice in one turn, for two different computers.
		accepting.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "a" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Laptop", reason: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await accepting.harness.session.prompt("move twice");
		await accepting.harness.session.agent.waitForIdle();

		// Then: the second is refused without asking the host; one move, one due notice, for Studio.
		const second = getToolResult(accepting.harness, "relocate_session");
		expect(second.details).toMatchObject({ status: "refused", reason: "already_scheduled" });
		expect(textOf(second)).toContain("Studio");
		expect(hostRequests(accepting.records)).toHaveLength(1);
		expect(accepting.records.filter((record) => record.type === "relocation_due")).toEqual([
			expect.objectContaining({ target: "Studio" }),
		]);
	});
});
