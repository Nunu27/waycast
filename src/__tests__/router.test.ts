import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Waycast } from "../router.ts";

describe("Waycast router", () => {
	it("registers rpc and data routes and merges sub-routers", () => {
		const sub = new Waycast()
			.rpc("test:rpc:[id]", { payload: z.object({ value: z.string() }) })
			.data("test:data:[id]", z.string());

		const router = new Waycast().merge(sub);

		expect(router._routes.size).toBe(2);
		expect(router._routes.get("test:rpc:[id]")?.kind).toBe("rpc");
		expect(router._routes.get("test:data:[id]")?.kind).toBe("data");
	});

	it("defaults maxDisconnectionDuration to 5000ms", () => {
		expect(new Waycast().options.maxDisconnectionDuration).toBe(5000);
		expect(
			new Waycast({ maxDisconnectionDuration: 1000 }).options
				.maxDisconnectionDuration,
		).toBe(1000);
	});

	it("merge throws on conflicting route names", () => {
		const a = new Waycast().data("x", z.string());
		const b = new Waycast().data("x", z.number());
		expect(() => new Waycast().merge(a).merge(b)).toThrow(
			'Route "x" already exists',
		);
	});
});
