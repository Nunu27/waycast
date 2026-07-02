import { describe, expect, it } from "bun:test";
import { createInMemoryDisposalScheduler } from "../scheduler.ts";

describe("createInMemoryDisposalScheduler", () => {
	it("fires onDue after the delay elapses", async () => {
		const scheduler = createInMemoryDisposalScheduler();
		const due: string[] = [];
		scheduler.onDue((key) => due.push(key));

		scheduler.schedule("topic-a", 10);
		expect(due).toEqual([]);

		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(due).toEqual(["topic-a"]);
	});

	it("cancel prevents onDue from firing", async () => {
		const scheduler = createInMemoryDisposalScheduler();
		const due: string[] = [];
		scheduler.onDue((key) => due.push(key));

		scheduler.schedule("topic-a", 10);
		scheduler.cancel("topic-a");

		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(due).toEqual([]);
	});

	it("re-scheduling replaces the previous deadline (latest disconnect wins)", async () => {
		const scheduler = createInMemoryDisposalScheduler();
		const due: string[] = [];
		scheduler.onDue((key) => due.push(key));

		scheduler.schedule("topic-a", 10);
		scheduler.schedule("topic-a", 50);

		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(due).toEqual([]); // first deadline should have been replaced, not fired

		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(due).toEqual(["topic-a"]);
	});
});
