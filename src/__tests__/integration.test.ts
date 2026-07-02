import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Waycast } from "../router.ts";
import {
	createLinkedInMemoryAdapters,
	createMemoryServerTransport,
} from "../testing.ts";

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("rpc happy path", () => {
	it("delivers replies and the final response", async () => {
		const router = new Waycast()
			.rpc("greet:[name]", {
				payload: z.object({ loud: z.boolean() }),
				response: z.string(),
				replies: { info: z.string() },
			})
			.data("noop", z.string());

		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });
		server.on("greet:[name]", async ({ params, payload, reply }) => {
			reply("info", `greeting ${params.name}`);
			return payload.loud ? `HELLO ${params.name}` : `hello ${params.name}`;
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});

		const info: string[] = [];
		const response = await new Promise<string>((resolve) => {
			client.rpc("greet:[name]", {
				params: { name: "ada" },
				payload: { loud: true },
				callbacks: {
					info: (msg) => info.push(msg),
					response: resolve,
				},
			});
		});

		expect(info).toEqual(["greeting ada"]);
		expect(response).toBe("HELLO ada");
	});

	it("rejects an invalid payload before the handler runs", async () => {
		const router = new Waycast().rpc("strict", {
			payload: z.object({ n: z.number() }),
		});
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });
		let handlerCalled = false;
		server.on("strict", async () => {
			handlerCalled = true;
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});

		const error = await new Promise<string>((resolve) => {
			client.rpc("strict", {
				params: {},
				payload: { n: "not a number" } as unknown as { n: number },
				callbacks: { error: resolve },
			});
		});

		expect(handlerCalled).toBe(false);
		expect(error).toBeTruthy();
	});

	it("delivers a thrown handler error as the error reply", async () => {
		const router = new Waycast().rpc("boom");
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });
		server.on("boom", async () => {
			throw new Error("kaboom");
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});

		const error = await new Promise<string>((resolve) => {
			client.rpc("boom", {
				params: {},
				payload: undefined,
				callbacks: { error: resolve },
			});
		});

		expect(error).toBe("kaboom");
	});
});

describe("middlewares", () => {
	it("can extend context via next({ context }) for downstream handlers", async () => {
		const router = new Waycast<{ private?: boolean }>().rpc("whoami", {
			response: z.string(),
			meta: { private: true },
		});
		const serverTransport = createMemoryServerTransport<{ userId: string }>();
		const server = router.buildServer<{ userId: string }>({
			transport: serverTransport,
			middlewares: [
				async ({ context, next }) =>
					next({ context: { role: `role-of-${context.userId}` } }),
			],
		});

		let seenRole: string | undefined;
		server.on("whoami", async ({ context }) => {
			seenRole = (context as { role?: string }).role;
			return "ok";
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient({ userId: "ada" }),
		});
		await new Promise<void>((resolve) => {
			client.rpc("whoami", {
				params: {},
				payload: undefined,
				callbacks: { response: () => resolve() },
			});
		});

		expect(seenRole).toBe("role-of-ada");
	});

	it("not calling next() short-circuits with an error reply", async () => {
		const router = new Waycast().rpc("guarded");
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({
			transport: serverTransport,
			middlewares: [async () => "rejected without calling next"],
		});
		let handlerCalled = false;
		server.on("guarded", async () => {
			handlerCalled = true;
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});
		const error = await new Promise<string>((resolve) => {
			client.rpc("guarded", {
				params: {},
				payload: undefined,
				callbacks: { error: resolve },
			});
		});

		expect(handlerCalled).toBe(false);
		expect(error).toContain("short-circuited");
	});

	it("rejects a data subscription when middleware short-circuits", async () => {
		const router = new Waycast().data("secret", z.string());
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({
			transport: serverTransport,
			middlewares: [
				async ({ type }) => (type === "data" ? Promise.resolve() : undefined),
			],
		});
		void server;

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});
		// give handshake + subscribe a moment, then confirm no data ever arrives because
		// the middleware above never calls next()
		let received: string | undefined;
		client.onData("secret", {
			params: {},
			callback: (data) => (received = data),
		});
		await sleep(100);
		expect(received).toBeUndefined();
	});
});

describe("data pub/sub", () => {
	it("delivers emitted data to subscribers, scoped by params", async () => {
		const router = new Waycast().data("room:[id]:messages", z.string());
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});
		const received: string[] = [];
		client.onData("room:[id]:messages", {
			params: { id: "1" },
			callback: (data) => received.push(data),
		});

		await sleep(80); // let the debounced subscribe flush
		server.emit("room:[id]:messages", {
			params: { id: "1" },
			data: "hello room 1",
		});
		server.emit("room:[id]:messages", {
			params: { id: "2" },
			data: "hello room 2",
		});
		await sleep(20);

		expect(received).toEqual(["hello room 1"]);
	});

	it("unsubscribing stops further delivery", async () => {
		const router = new Waycast().data("ticks", z.number());
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});
		const received: number[] = [];
		const unsub = client.onData("ticks", {
			params: {},
			callback: (data) => received.push(data),
		});

		await sleep(80);
		server.emit("ticks", { params: {}, data: 1 });
		await sleep(20);
		unsub();
		await sleep(80);
		server.emit("ticks", { params: {}, data: 2 });
		await sleep(20);

		expect(received).toEqual([1]);
	});
});

describe("rpc disposal", () => {
	it("calls onDispose immediately on an explicit cancel", async () => {
		const router = new Waycast().rpc("long-running", {
			replies: { info: z.string() },
		});
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });

		const disposed: string[] = [];
		server.onDispose("long-running", (_connectionId, requestId) =>
			disposed.push(requestId),
		);
		server.on("long-running", async () => {
			// never resolves on its own — only ends via cancel
			await new Promise(() => {});
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});
		const cancel = client.rpc("long-running", {
			params: {},
			payload: undefined,
			callbacks: {},
		});

		await sleep(20);
		cancel();
		await sleep(80); // cancel() queues a debounced unsubscribe (50ms default)

		expect(disposed.length).toBe(1);
	});

	it("schedules disposal on disconnect and cancels it on resubscribe within the grace period", async () => {
		const router = new Waycast({ maxDisconnectionDuration: 60 }).rpc("session");
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });

		const disposed: string[] = [];
		server.onDispose("session", (_connectionId, requestId) =>
			disposed.push(requestId),
		);
		server.on("session", async () => {
			await new Promise(() => {});
		});

		const clientTransport = serverTransport.connectClient(undefined);
		const client = router.buildClient({ transport: clientTransport });
		client.rpc("session", { params: {}, payload: undefined, callbacks: {} });
		await sleep(20);

		clientTransport.disconnect();

		// reconnect well within the 60ms grace period — same client instance, transport
		// internally reconnects and resubscribes to the still-pending rpc reply topic
		await sleep(10);
		clientTransport.simulateReconnect();

		await sleep(100);
		expect(disposed.length).toBe(0);
	});

	it("fires onDispose exactly once after the grace period with no reconnect", async () => {
		const router = new Waycast({ maxDisconnectionDuration: 30 }).rpc("session");
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });

		const disposed: string[] = [];
		server.onDispose("session", (_connectionId, requestId) =>
			disposed.push(requestId),
		);
		server.on("session", async () => {
			await new Promise(() => {});
		});

		const clientTransport = serverTransport.connectClient(undefined);
		router.buildClient({ transport: clientTransport });
		clientTransport.send(
			JSON.stringify({
				type: "rpc",
				name: "session",
				requestId: "req-1",
				params: {},
			}),
		);
		await sleep(20);

		clientTransport.disconnect();
		await sleep(80);

		expect(disposed).toEqual(["req-1"]);
	});

	it("aborts the handler's signal on an explicit cancel", async () => {
		const router = new Waycast().rpc("long-running", {
			replies: { info: z.string() },
		});
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });

		let signal: AbortSignal | undefined;
		server.on("long-running", async ({ signal: s }) => {
			signal = s;
			await new Promise(() => {});
		});

		const client = router.buildClient({
			transport: serverTransport.connectClient(undefined),
		});
		const cancel = client.rpc("long-running", {
			params: {},
			payload: undefined,
			callbacks: {},
		});

		await sleep(20);
		expect(signal?.aborted).toBe(false);

		cancel();
		await sleep(80); // cancel() queues a debounced unsubscribe (50ms default)

		expect(signal?.aborted).toBe(true);
	});

	it("disposes immediately when the client resubscribes on a different instance", async () => {
		const router = new Waycast({ maxDisconnectionDuration: 5000 }).rpc(
			"session",
		);
		const [adapterA, adapterB] = createLinkedInMemoryAdapters(2);

		const transportA = createMemoryServerTransport<undefined>();
		const serverA = router.buildServer({
			transport: transportA,
			adapter: adapterA,
		});
		const disposed: string[] = [];
		serverA.onDispose("session", (_connectionId, requestId) =>
			disposed.push(requestId),
		);
		serverA.on("session", async () => {
			await new Promise(() => {});
		});

		const transportB = createMemoryServerTransport<undefined>();
		router.buildServer({ transport: transportB, adapter: adapterB });

		const clientA = transportA.connectClient(undefined);
		router.buildClient({ transport: clientA });
		clientA.send(
			JSON.stringify({
				type: "rpc",
				name: "session",
				requestId: "req-1",
				params: {},
			}),
		);
		await sleep(20);

		clientA.disconnect();
		await sleep(10);

		// client resurfaces on a different instance and tries to resubscribe to the same
		// pending rpc's reply topic — instance B doesn't own it, so it should broadcast an
		// abandonment that lets instance A dispose right away instead of waiting out its
		// 5000ms disconnect grace period
		const clientB = transportB.connectClient(undefined);
		router.buildClient({ transport: clientB });
		clientB.send(
			JSON.stringify({ type: "subscribe", topics: ["session|req-1|reply"] }),
		);
		await sleep(20);

		expect(disposed).toEqual(["req-1"]);
	});

	it("calls the client's error callback when the connection never comes back", async () => {
		const router = new Waycast({ maxDisconnectionDuration: 30 }).rpc("session");
		const serverTransport = createMemoryServerTransport<undefined>();
		const server = router.buildServer({ transport: serverTransport });
		server.on("session", async () => {
			await new Promise(() => {});
		});

		const clientTransport = serverTransport.connectClient(undefined);
		const client = router.buildClient({ transport: clientTransport });

		const errors: string[] = [];
		client.rpc("session", {
			params: {},
			payload: undefined,
			callbacks: { error: (err) => errors.push(err) },
		});
		await sleep(20);

		clientTransport.disconnect();
		await sleep(80); // past the 30ms grace period, no reconnect

		expect(errors.length).toBe(1);
	});
});

describe("handshake", () => {
	it("rejects a connection whose router fingerprint does not match", async () => {
		const serverRouter = new Waycast().rpc("a");
		const clientRouter = new Waycast().rpc("b"); // different route manifest -> different fingerprint

		const serverTransport = createMemoryServerTransport<undefined>();
		serverRouter.buildServer({ transport: serverTransport });

		const clientTransport = serverTransport.connectClient(undefined);
		const originalConnect = clientTransport.connect.bind(clientTransport);
		let closed = false;
		clientTransport.connect = (handlers) =>
			originalConnect({
				...handlers,
				onClose: () => {
					closed = true;
					handlers.onClose();
				},
			});

		const errors: unknown[] = [];
		clientRouter.buildClient({
			transport: clientTransport,
			logger: {
				log: () => {},
				warn: () => {},
				error: (err) => errors.push(err),
			},
		});
		await sleep(20);

		// the server's onHandshakeMismatch (default: transport.disconnect(connectionId)) force-closes
		// the connection server-side, which surfaces to the client as onClose — and separately the
		// client logs the mismatch itself when it sees `{ type: "handshake", ok: false }`
		expect(closed).toBe(true);
		expect(errors.length).toBe(1);
	});
});
