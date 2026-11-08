import { describe, expect, it } from "vitest";
import { Agent, type StepCommit, type StreamFn } from "../src/index.ts";
import { scripted, stopStep, type Step } from "./utils/scripted-step-loop.ts";

const asStreamFn = (steps: readonly Step[]): StreamFn => scripted(steps) as unknown as StreamFn;

function recordingAgent(steps: readonly Step[], commitStep?: (step: StepCommit) => Promise<void>) {
	const optionKeys: string[][] = [];
	const inner = asStreamFn(steps);
	const streamFn: StreamFn = (model, context, options) => {
		optionKeys.push(Object.keys(options ?? {}));
		return inner(model, context, options);
	};
	const trace: string[] = [];
	const agent = new Agent({ streamFn, ...(commitStep ? { commitStep } : {}) });
	agent.subscribe((event) => {
		trace.push(event.type === "message_end" ? `message_end:${event.message.role}` : event.type);
	});
	return { agent, optionKeys, trace };
}

describe("CK1p: Agent forwards AgentOptions.commitStep to every loop run (custody C.P3)", () => {
	it("commits the step of an initial prompt", async () => {
		const commits: string[] = [];
		const { agent } = recordingAgent([stopStep], async (step) => {
			commits.push(step.message.stopReason);
		});

		await agent.prompt("go");

		expect(commits).toEqual(["stop"]);
	});

	it("commits the steps of a queued follow-up drained after the run", async () => {
		const commits: string[] = [];
		const { agent } = recordingAgent([stopStep, stopStep], async (step) => {
			commits.push(step.message.stopReason);
		});
		// Queued at agent_end, after the in-loop follow-up poll, so only the post-run drain can pick it up.
		let queued = false;
		agent.subscribe((event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			agent.followUp({ role: "user", content: [{ type: "text", text: "next" }], timestamp: 2 });
		});

		await agent.prompt("go");
		await agent.waitForIdle();

		expect(commits).toEqual(["stop", "stop"]);
	});

	it("commits the step of a continuation (the retry path)", async () => {
		const commits: string[] = [];
		const { agent } = recordingAgent([stopStep], async (step) => {
			commits.push(step.message.stopReason);
		});
		agent.state.messages = [{ role: "user", content: [{ type: "text", text: "resume" }], timestamp: 1 }];

		await agent.continue();

		expect(commits).toEqual(["stop"]);
	});

	it("forwards the key only when set, so a fused agent's stream options stay key-identical (cond 5)", async () => {
		const unset = recordingAgent([stopStep]);
		const set = recordingAgent([stopStep], async () => {});

		await unset.agent.prompt("go");
		await set.agent.prompt("go");

		expect(unset.optionKeys.flat()).not.toContain("commitStep");
		expect(set.optionKeys.flat()).toContain("commitStep");
	});

	it("emits the same events with commitStep unset as with a commit that always succeeds", async () => {
		let commits = 0;
		const unset = recordingAgent([stopStep]);
		const set = recordingAgent([stopStep], async () => {
			commits += 1;
		});

		await unset.agent.prompt("go");
		await set.agent.prompt("go");

		expect(commits).toBe(1);
		expect(set.trace).toEqual(unset.trace);
	});
});
