import { describe, expect, it } from "vitest";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

const ETHOS_IDS = [
	"ethos.tuning-discipline",
	"ethos.tools-transparent",
	"ethos.only-harness",
	"ethos.spend-tokens",
	"ethos.deep-work",
	"ethos.ulw-plan-sage",
	"ethos.ulw-loop-shallow",
	"ethos.monitor-subscribe",
	"ethos.cache-budget",
	"ethos.cache-hit-rate",
	"ethos.multimodal-vision",
	"ethos.oauth-multi-account",
	"ethos.agent-sdk-foundation",
	"ethos.tool-call-repair",
] as const;

const noopKeys = (): string => "";

describe("ethos tips", () => {
	it("registers every ethos tip id", () => {
		const ids = new Set(TIP_DEFINITIONS.map((tip) => tip.id));

		for (const id of ETHOS_IDS) {
			expect(ids, `missing ${id}`).toContain(id);
		}
	});

	it("renders the approved English copy verbatim", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip.render(noopKeys)]));

		expect(byId.get("ethos.tuning-discipline")).toBe(
			"gpt-5.6-sol used to turn a sprint into a marathon. We tuned the system prompt and killed that habit: 5-minute jobs take 5 minutes, 12-hour jobs take 12.",
		);
		expect(byId.get("ethos.tools-transparent")).toBe(
			"Don't study our tools. A tool that needs studying is a tool that failed. We just ride shotgun while you keep doing your actual job.",
		);
		expect(byId.get("ethos.only-harness")).toBe(
			"The only harness that actually knows how to drive gpt-5.6-sol. Same job, feels up to 30% faster. *we counted*",
		);
		expect(byId.get("ethos.spend-tokens")).toBe(
			"Stop hoarding tokens. Spend them like they buy your hours back, because they do.",
		);
		expect(byId.get("ethos.deep-work")).toBe(
			"Using our tools means your work is already the deep, valuable kind. Keep your eyes on the essence of your craft. The rest is our problem now, and we're great at problems.",
		);
		expect(byId.get("ethos.ulw-plan-sage")).toBe(
			"Try ulw-plan on fable-5.1 xhigh. A patient sage obsessed with the essence does the agonizing for you and fills in every blank you were pretending not to see.",
		);
		expect(byId.get("ethos.ulw-loop-shallow")).toBe(
			"For days when deep thought sounds awful, run the ulw loop with gpt-5.6-sol fast/medium. Fair warning: shallow thinking sends invoices.",
		);
		expect(byId.get("ethos.monitor-subscribe")).toBe(
			"Subscribe to a command's stdout and forget it. CI finishes, server boots, log line lands... you're mid-edit and the news finds *you*. No sleep loops, no polling, no re-reading context like a chump.",
		);
		expect(byId.get("ethos.cache-budget")).toBe(
			"My harness knows the prompt cache's expiry to the second and never blocks past it. Cold re-read tax? *Refused on your behalf.* Other agents eat that cost, mine declines it.",
		);
		expect(byId.get("ethos.cache-hit-rate")).toBe(
			"Live cache-hit rate in the footer, plus a running tab of misses, idle gaps, and model swaps. I can point at the exact moment cache broke and why. Watching tokens you never re-pay stack up? Smug doesn't cover it.",
		);
		expect(byId.get("ethos.multimodal-vision")).toBe(
			"Drop a screenshot, a PDF, a crusty whiteboard photo... senpi actually sees it, reads it, reasons about it. Your agent has eyes now. *Yes, really.*",
		);
		expect(byId.get("ethos.oauth-multi-account")).toBe(
			"Hit a rate limit, switch accounts. Wrong org, switch again. senpi treats your Claude logins like a roster, not a single lifeline. *Env vars could never.*",
		);
		expect(byId.get("ethos.agent-sdk-foundation")).toBe(
			'Built on the official agent SDK, speaking the protocol natively. No reverse-engineered wrapper, no ToS gray zone, no "will I get banned for this" anxiety. *Sleep easy, ship loud.*',
		);
		expect(byId.get("ethos.tool-call-repair")).toBe(
			"senpi catches malformed tool calls on the wire, fixes them, and salvages the turn - claude's sloppy invokes, kimi k3's leaked XTML channels, all of it. Other harnesses retry the whole thing and bill you for the privilege. *table stakes, honestly*",
		);
	});

	it("gates the ulw command tips on the tasks command", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		expect(byId.get("ethos.ulw-plan-sage")?.requiresCommand).toBe("tasks");
		expect(byId.get("ethos.ulw-loop-shallow")?.requiresCommand).toBe("tasks");
	});

	it("leaves the pure manifesto tips unbound and ungated", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		for (const id of [
			"ethos.tuning-discipline",
			"ethos.tools-transparent",
			"ethos.only-harness",
			"ethos.spend-tokens",
			"ethos.deep-work",
			"ethos.monitor-subscribe",
			"ethos.cache-budget",
			"ethos.cache-hit-rate",
			"ethos.multimodal-vision",
			"ethos.oauth-multi-account",
			"ethos.agent-sdk-foundation",
			"ethos.tool-call-repair",
		] as const) {
			const tip = byId.get(id);
			expect(tip?.bindings, id).toEqual([]);
			expect(tip?.requiresCommand, id).toBeUndefined();
		}
	});
});
