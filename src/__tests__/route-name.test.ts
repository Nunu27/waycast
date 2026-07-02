import { describe, expect, it } from "bun:test";
import { buildRouteName, compileRoute, matchRoute } from "../route-name.ts";

describe("route-name", () => {
	it("matches a route with no params", () => {
		const compiled = compileRoute("test:data:list");
		expect(compiled.paramNames).toEqual([]);
		expect(matchRoute(compiled, "test:data:list")).toEqual({});
		expect(matchRoute(compiled, "test:data:other")).toBeUndefined();
	});

	it("extracts a single param", () => {
		const compiled = compileRoute("test:rpc:[id]");
		expect(compiled.paramNames).toEqual(["id"]);
		expect(matchRoute(compiled, "test:rpc:42")).toEqual({ id: "42" });
	});

	it("extracts multiple params", () => {
		const compiled = compileRoute("room:[roomId]:user:[userId]");
		expect(matchRoute(compiled, "room:1:user:2")).toEqual({
			roomId: "1",
			userId: "2",
		});
	});

	it("does not match across param boundaries (no colon in param value)", () => {
		const compiled = compileRoute("test:rpc:[id]");
		expect(matchRoute(compiled, "test:rpc:42:extra")).toBeUndefined();
	});

	it("builds a concrete name from params", () => {
		expect(
			buildRouteName("room:[roomId]:user:[userId]", {
				roomId: "1",
				userId: "2",
			}),
		).toBe("room:1:user:2");
	});

	it("throws when a required param is missing", () => {
		expect(() => buildRouteName("test:rpc:[id]", {})).toThrow(/Missing param/);
	});

	it("round-trips a param value containing a colon", () => {
		const built = buildRouteName("room:[id]:messages", { id: "tenant:42" });
		expect(built).toBe("room:tenant%3A42:messages");
		const compiled = compileRoute("room:[id]:messages");
		expect(matchRoute(compiled, built)).toEqual({ id: "tenant:42" });
	});

	it("round-trips a param value containing a pipe", () => {
		const built = buildRouteName("room:[id]:messages", { id: "a|b" });
		const compiled = compileRoute("room:[id]:messages");
		expect(matchRoute(compiled, built)).toEqual({ id: "a|b" });
	});

	it("disambiguates a param value that contains another param's separator text", () => {
		// roomId's value embeds the literal text "user:" that also separates the two params —
		// without encoding, greedy regex backtracking would misattribute characters between params
		const built = buildRouteName("room:[roomId]:user:[userId]", {
			roomId: "a",
			userId: "user:x",
		});
		const compiled = compileRoute("room:[roomId]:user:[userId]");
		expect(matchRoute(compiled, built)).toEqual({
			roomId: "a",
			userId: "user:x",
		});
	});
});
