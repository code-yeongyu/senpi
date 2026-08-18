/**
 * Server-side playbooks for the two exec-lifecycle scenarios.
 *
 * Both gate `turnEnded` on the client's actual decoded exec traffic:
 *  - read lifecycle: typed readResult{id} THEN exactly one streamClose{id}
 *  - pending shell: heartbeat{id} observed (bounded 3s-interval wait) before
 *    the FIFO gate releases the bridged tool, then shellResult{id} then
 *    exactly one streamClose{id}.
 *
 * Every wait is on a decoded frame; the only timing bound is the timeout,
 * and the heartbeat's own interval is the behavior under test.
 */

const isExecResult = (entry, id, messageCase) =>
	entry.case === "execClientMessage" && entry.id === id && entry.message === messageCase;
const isControl = (entry, id, controlCase) =>
	entry.case === "execClientControlMessage" && entry.control === controlCase && entry.id === id;

async function finishTurn(server, wire, finalText) {
	await server.send(wire.textDeltaFrame(finalText));
	await server.send(wire.turnEndedFrame());
	await server.send(wire.endStreamFrame());
	server.endStream();
	await server.clientClosed();
}

export async function playReadLifecycle(server, wire, { id, path, toolCallId, finalText }) {
	await server.waitForRun(30000);
	await server.send(wire.textDeltaFrame("Reading the QA target file now."));
	await server.send(wire.execReadFrame({ id, path, toolCallId }));
	const result = await server.waitFor((e) => isExecResult(e, id, "readResult"), 30000, `readResult{id:${id}}`);
	const close = await server.waitFor((e) => isControl(e, id, "streamClose"), 10000, `streamClose{id:${id}}`);
	await finishTurn(server, wire, finalText);
	return { result, close };
}

export async function playPendingShell(server, wire, { id, command, workingDirectory, toolCallId, release, finalText }) {
	await server.waitForRun(30000);
	await server.send(wire.execShellStreamFrame({ id, command, workingDirectory, toolCallId }));
	// The pending window is bounded by the exec heartbeat's own 3000ms
	// interval plus transport slack; the gate is released ONLY after the
	// decoded heartbeat for this exec id arrives.
	const heartbeat = await server.waitFor((e) => isControl(e, id, "heartbeat"), 9000, `exec heartbeat{id:${id}}`);
	await release();
	const result = await server.waitFor((e) => isExecResult(e, id, "shellResult"), 30000, `shellResult{id:${id}}`);
	const close = await server.waitFor((e) => isControl(e, id, "streamClose"), 10000, `streamClose{id:${id}}`);
	await finishTurn(server, wire, finalText);
	return { heartbeat, result, close };
}
