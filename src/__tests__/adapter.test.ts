import { describe, expect, it } from "bun:test";
import { createInMemoryAdapter } from "../adapter.ts";

describe("createInMemoryAdapter", () => {
	it("delivers published messages to the registered onMessage handler", () => {
		const adapter = createInMemoryAdapter();
		const received: { topic: string; raw: string }[] = [];
		adapter.onMessage((topic, raw) => received.push({ topic, raw }));

		adapter.publish("topic-a", "hello");

		expect(received).toEqual([{ topic: "topic-a", raw: "hello" }]);
	});

	it("does nothing if publish happens before a handler is registered", () => {
		const adapter = createInMemoryAdapter();
		expect(() => adapter.publish("topic-a", "hello")).not.toThrow();
	});
});
