// EQ mutation evidence (plan P0-05d, §6.4 "Mutation evidence"): every row of the plan's mutation table, the patch that
// makes it, the EQ cases that must FAIL with it applied, and the diff row each failing case must show. Run by
// scripts/scenarios/fused-equivalence-mutations-qa.mjs; README.md here says what each patch changes.
//
// `expect.<case>` is matched against each diff row of that case as `<path>: golden=<json> actual=<json>` (untruncated;
// lib/equivalence-mutations.mjs diffRowText). A row with `deferred` has no patch in this repo: its owner supplies it.

export const mutations = Object.freeze([
	{
		id: "o1-dropped-prompt-segment",
		row: "dropped prompt segment",
		observation: "O1",
		surface: "rpc",
		patch: "o1-dropped-prompt-segment.patch",
		cases: ["E01"],
		expect: {
			E01: /^\$\.O1\[0\]\.body\.messages\[0\]\.content: golden=".*- Judgment asks \(what do you think, review\).*" actual="(?![\s\S]*Judgment asks \(what do you think)/,
		},
	},
	{
		id: "o2-swapped-model",
		row: "swapped model",
		observation: "O2",
		surface: "rpc",
		patch: "o2-swapped-model.patch",
		cases: ["E01"],
		expect: { E01: /^\$\.O2\[0\]\.model: golden="mock-model" actual="mock-model-b"$/ },
	},
	{
		id: "o3-dropped-declaration",
		row: "dropped declaration",
		observation: "O3",
		surface: "rpc",
		patch: "o3-dropped-declaration.patch",
		cases: ["E01"],
		expect: { E01: /^\$\.O3\[0\]\[\d+\]: golden=\{"type":"function","function":\{"name":"[^"]+"/ },
	},
	{
		id: "o4-dropped-custom-header",
		row: "dropped custom header",
		observation: "O4",
		surface: "rpc",
		patch: "o4-dropped-custom-header.patch",
		cases: ["E01"],
		expect: {
			E01: /^\$\.O4\[0\]\.user-agent: golden="pi \([a-z0-9]+ <host:release>; [a-z0-9]+\)" actual="OpenAI\/JS [0-9.]+"$/,
		},
	},
	{
		id: "o4-swapped-synthetic-credentials",
		row: "swapped synthetic credentials",
		observation: "O4",
		surface: "rpc",
		patch: "o4-swapped-synthetic-credentials.patch",
		cases: ["E01"],
		expect: {
			E01: /^\$\.O4\[0\]\.authorization: golden="<redacted:sha256:01274dd5010dcac7>" actual="<redacted:sha256:(?!01274dd5010dcac7)[0-9a-f]{16}>"$/,
		},
	},
	{
		id: "o5-wrong-target-other-dir",
		row: "wrong effect target in another dir",
		observation: "O5",
		surface: "rpc",
		patch: "o5-wrong-target-other-dir.patch",
		cases: ["E02"],
		expect: { E02: /^\$\.O5\.tree\.out\/seq-1\.txt: golden=\{"text":"seq_1\\n"\} actual=undefined$/ },
	},
	{
		id: "o5-wrong-target-same-sandbox",
		row: "wrong effect target in the same sandbox",
		observation: "O5",
		surface: "rpc",
		patch: "o5-wrong-target-same-sandbox.patch",
		cases: ["E02"],
		expect: { E02: /^\$\.O5\.tree\.out\/seq-1\.txt\.moved: golden=undefined actual=\{"text":"seq_1\\n"\}$/ },
	},
	{
		id: "o5-reordered-effects",
		row: "reordered effects",
		observation: "O5",
		surface: "rpc",
		patch: "o5-reordered-effects.patch",
		cases: ["E03"],
		expect: { E03: /^\$\.O5\.extra\[1\]\.arrivedBefore\[0\]: golden="wave-w1" actual="wave-s3"$/ },
	},
	{
		id: "o6o7-merged-ids",
		row: "merged IDs",
		observation: "O6/O7",
		surface: "rpc",
		patch: "o6o7-merged-ids.patch",
		cases: ["E01"],
		expect: { E01: /^\$\.O7\.entries\[\d+\]\.message\.toolCallId: golden="<id:(\d+)>" actual="<id:(?!\1>)\d+>"$/ },
	},
	{
		id: "o8-tui-removed-dialog-option",
		row: "removed widget/dialog",
		observation: "O8 TUI",
		surface: "tui",
		patch: "o8-tui-removed-dialog-option.patch",
		cases: ["E17"],
		expect: { E17: /^\$\.O8\.tui\[\d+\]\.lines\[\d+\]: golden="[^"]*Allow always/ },
	},
	{
		id: "o8-desktop-broken-render",
		row: "broken desktop render",
		observation: "O8 desktop",
		surface: "desktop",
		deferred: {
			owner: "P0-07b",
			due: "VER-P0-07b",
			reason:
				"EQ.desktop (desktop scripts/qa/fused-equivalence-desktop.ts) owns the desktop render capture; P0-07b ships the broken-render patch and runs it against its own goldens",
		},
	},
	{
		id: "e25-rerun-interrupted-call",
		row: "interrupted call re-run on resume (E25)",
		observation: "O5",
		surface: "rpc",
		patch: "e25-rerun-interrupted-call.patch",
		cases: ["E25"],
		expect: {
			E25: /^\$\.O5\.tree\.ledger\.txt\.text: golden="call_body\\ncall_sibling_done\\ncall_sibling_held\\ncall_question_bad\\n" actual="call_body\\ncodemode-/,
		},
	},
	{
		id: "e30-tool-result-to-other-session",
		row: "tool result delivered to the other session (E30)",
		observation: "O6/O7",
		surface: "rpc",
		patch: "e30-tool-result-to-other-session.patch",
		cases: ["E30"],
		expect: {
			E30: /^error: Error: E30 solo compare: session A differs from its solo run in \d+ row\(s\): \$\.O6\[0\]\.events\[\d+\]\.type: solo="[a-z_]+" concurrent="tool_execution_end";/,
		},
	},
]);
