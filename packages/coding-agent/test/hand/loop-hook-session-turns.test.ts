// #6751 follow-up (review L3): what a hand keeps per loop session to answer whether it is idle after a turn. It keeps
// a session only between a turn's end and the next turn's start, never one per session it served.
import { describe, expect, it } from "vitest";
import { createSessionTurns } from "../../src/modes/rpc/loop-hook-session-turns.ts";

describe("a hand's view of its loop sessions' turns", () => {
	it("holds a session only while it is idle after a turn, never one per session served", () => {
		const turns = createSessionTurns();
		const readers = Array.from({ length: 100 }, (_, index) => {
			turns.started(`session-${index}`);
			return turns.ended(`session-${index}`);
		});
		const heldWhileIdle = turns.size;

		for (let index = 0; index < 100; index++) turns.started(`session-${index}`);

		expect({ heldWhileIdle, held: turns.size, idle: readers.some((reader) => reader()) }).toEqual({
			heldWhileIdle: 100,
			held: 0,
			idle: false,
		});
	});

	it("answers idle for every ended turn of a session until its next turn starts, and only that session's", () => {
		const turns = createSessionTurns();
		const first = turns.ended("a");
		const second = turns.ended("a");
		const other = turns.ended("b");

		turns.started("a");

		expect({ first: first(), second: second(), other: other(), held: turns.size }).toEqual({
			first: false,
			second: false,
			other: true,
			held: 1,
		});
	});
});
