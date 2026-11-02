export const typedAgentResponse = {
	text: '{"answer":42}',
	id: "st_abc123",
	handle: "agent://st_abc123",
	run_epoch: 2,
	agent: "reviewer",
} as const;

export const malformedHandles: readonly unknown[] = [
	undefined,
	null,
	[],
	{},
	{ task_id: "st_123abc" },
	{ task_id: "st_123abc", run_epoch: -1 },
	{ task_id: "st_123abc", run_epoch: 1.5 },
	{ task_id: "st_123abc", run_epoch: "0" },
	{ task_id: "st_123abc", run_epoch: null },
	{ task_id: "st_123abc", run_epoch: Infinity },
	{ task_id: "st_legacy_id", run_epoch: 0 },
	{ task_id: "st_ABCDEF", run_epoch: 0 },
	{ taskId: "st_123abc", run_epoch: 0 },
	{ id: "st_123abc", run_epoch: 0 },
];
