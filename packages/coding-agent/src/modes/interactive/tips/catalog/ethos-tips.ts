import { APP_NAME } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const ETHOS_TIPS = [
	{
		id: "ethos.tuning-discipline",
		bindings: [],
		render: () =>
			"gpt-5.6-sol used to turn a sprint into a marathon. We tuned the system prompt and killed that habit: 5-minute jobs take 5 minutes, 12-hour jobs take 12.",
	},
	{
		id: "ethos.tools-transparent",
		bindings: [],
		render: () =>
			"Don't study our tools. A tool that needs studying is a tool that failed. We just ride shotgun while you keep doing your actual job.",
	},
	{
		id: "ethos.only-harness",
		bindings: [],
		render: () =>
			"The only harness that actually knows how to drive gpt-5.6-sol. Same job, feels up to 30% faster. *we counted*",
	},
	{
		id: "ethos.spend-tokens",
		bindings: [],
		render: () => "Stop hoarding tokens. Spend them like they buy your hours back, because they do.",
	},
	{
		id: "ethos.deep-work",
		bindings: [],
		render: () =>
			"Using our tools means your work is already the deep, valuable kind. Keep your eyes on the essence of your craft. The rest is our problem now, and we're great at problems.",
	},
	{
		id: "ethos.ulw-plan-sage",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"Try ulw-plan on fable-5 xhigh. A patient sage obsessed with the essence does the agonizing for you and fills in every blank you were pretending not to see.",
	},
	{
		id: "ethos.ulw-loop-shallow",
		bindings: [],
		requiresCommand: "tasks",
		render: () =>
			"For days when deep thought sounds awful, run the ulw loop with gpt-5.6-sol fast/medium. Fair warning: shallow thinking sends invoices.",
	},
	{
		id: "ethos.monitor-subscribe",
		bindings: [],
		render: () =>
			"Subscribe to a command's stdout and forget it. CI finishes, server boots, log line lands... you're mid-edit and the news finds *you*. No sleep loops, no polling, no re-reading context like a chump.",
	},
	{
		id: "ethos.cache-budget",
		bindings: [],
		render: () =>
			"My harness knows the prompt cache's expiry to the second and never blocks past it. Cold re-read tax? *Refused on your behalf.* Other agents eat that cost, mine declines it.",
	},
	{
		id: "ethos.cache-hit-rate",
		bindings: [],
		render: () =>
			"Live cache-hit rate in the footer, plus a running tab of misses, idle gaps, and model swaps. I can point at the exact moment cache broke and why. Watching tokens you never re-pay stack up? Smug doesn't cover it.",
	},
	{
		id: "ethos.multimodal-vision",
		bindings: [],
		render: () =>
			`Drop a screenshot, a PDF, a crusty whiteboard photo... ${APP_NAME} actually sees it, reads it, reasons about it. Your agent has eyes now. *Yes, really.*`,
	},
	{
		id: "ethos.oauth-multi-account",
		bindings: [],
		render: () =>
			`Hit a rate limit, switch accounts. Wrong org, switch again. ${APP_NAME} treats your Claude logins like a roster, not a single lifeline. *Env vars could never.*`,
	},
	{
		id: "ethos.agent-sdk-foundation",
		bindings: [],
		render: () =>
			'Built on the official agent SDK, speaking the protocol natively. No reverse-engineered wrapper, no ToS gray zone, no "will I get banned for this" anxiety. *Sleep easy, ship loud.*',
	},
	{
		id: "ethos.tool-call-repair",
		bindings: [],
		render: () =>
			`${APP_NAME} catches malformed tool calls on the wire, fixes them, and salvages the turn - claude's sloppy invokes, kimi k3's leaked XTML channels, all of it. Other harnesses retry the whole thing and bill you for the privilege. *table stakes, honestly*`,
	},
] satisfies readonly TipDefinition[];
