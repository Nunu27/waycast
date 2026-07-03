# waycast

[![npm version](https://img.shields.io/npm/v/waycast)](https://www.npmjs.com/package/waycast)
[![npm downloads](https://img.shields.io/npm/dm/waycast)](https://www.npmjs.com/package/waycast)
[![license](https://img.shields.io/npm/l/waycast)](./LICENSE)
[![typescript](https://img.shields.io/badge/TypeScript-5%2B-3178c6)](https://www.typescriptlang.org)

Transport-agnostic RPC and Pub/Sub library for TypeScript with end-to-end type safety and support for intermediate replies.

Works with any transport — WebSocket, Socket.io, gRPC, or anything else — by implementing a small `WaycastServerTransport` / `WaycastClientTransport` interface.

## Installation

```bash
npm install waycast
# or
bun add waycast
```

## Quick Start

```ts
import Waycast from "waycast";
import { z } from "zod"; // any Standard Schema validator works

// 1. Define your router (shared between server and client)
const router = new Waycast()
	.rpc("greet", {
		payload: z.object({ name: z.string() }),
		response: z.string()
	})
	.data("messages:[roomId]", z.string());

// 2. Build the server
const server = router.buildServer<{ userId: string }>({
	transport: myServerTransport
});

server.on("greet", async ({ payload, reply }) => {
	reply("response", `Hello, ${payload.name}!`);
});

server.emit("messages:[roomId]", {
	params: { roomId: "general" },
	data: "Hello everyone!"
});

// 3. Build the client
const client = router.buildClient({ transport: myClientTransport });

const cancel = client.rpc("greet", {
	payload: { name: "world" },
	callbacks: {
		response: (msg) => console.log(msg), // "Hello, world!"
		error: (err) => console.error(err)
	}
});

const unsub = client.onData("messages:[roomId]", {
	params: { roomId: "general" },
	callback: (msg) => console.log(msg)
});
```

## Router

The router is the shared contract between server and client. Define it once and use it in both.

```ts
import Waycast from "waycast";

type Meta = { roles?: string[] };

const router = new Waycast<Meta>({ maxDisconnectionDuration: 5000 })
	.rpc("users:get:[id]", {
		payload: z.object({ includeProfile: z.boolean() }),
		response: z.object({ name: z.string() }),
		replies: {
			progress: z.string() // intermediate reply before the final response
		},
		meta: { roles: ["admin"] } // typed against Meta, available in middlewares
	})
	.data("chat:[roomId]", z.string(), { roles: ["member"] });
```

**`new Waycast<Meta>(options?)`**

| Option                     | Default | Description                                                   |
| -------------------------- | ------- | ------------------------------------------------------------- |
| `maxDisconnectionDuration` | `5000`  | Ms to wait before disposing an RPC after a client disconnects |

**`.rpc(name, config?)`** — registers an RPC route. All config fields are optional.

| Field      | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `payload`  | Standard Schema for the incoming payload                         |
| `response` | Standard Schema for the return value                             |
| `replies`  | Map of named intermediate replies, each with its own schema      |
| `meta`     | Arbitrary metadata attached to this route (typed against `Meta`) |

**`.data(name, schema?, meta?)`** — registers a pub/sub data route. Both `schema` and `meta` are optional.

**`.merge(other)`** — merges two routers. Route name collisions throw at runtime.

### Parametrized route names

Route names can include `[paramName]` segments. Params are extracted automatically and passed to handlers and emit calls with full type safety:

```ts
const router = new Waycast()
  .rpc("rooms:[roomId]:messages:[msgId]", { ... })
  .data("feeds:[userId]", z.string());

// server
server.on("rooms:[roomId]:messages:[msgId]", ({ params }) => {
  params.roomId; // string
  params.msgId;  // string
});

// server emit
server.emit("feeds:[userId]", { params: { userId: "42" }, data: "hello" });

// client subscribe
client.onData("feeds:[userId]", { params: { userId: "42" }, callback: (d) => {} });
```

## Server

```ts
type Context = { userId: string; role: string };

const server = router.buildServer<Context>({
	transport, // required — WaycastServerTransport<Context>
	codec, // optional — default: JSON
	adapter, // optional — default: in-memory
	disposalScheduler, // optional — default: in-memory
	logger: console, // optional
	middlewares: [authMiddleware, loggingMiddleware], // optional
	errorFormatter: (err) => (err instanceof Error ? err.message : String(err)), // optional
	onHandshakeMismatch: (connectionId) => transport.disconnect(connectionId) // optional
});
```

### Handling RPC calls

```ts
server.on(
	"users:get:[id]",
	async ({
		params,
		payload,
		context,
		connectionId,
		requestId,
		reply,
		signal
	}) => {
		reply("progress", "Loading..."); // custom intermediate reply from the `replies` config

		const user = await db.getUser(params.id, { signal }); // pass through to cancel the underlying work

		return { name: user.name }; // sends "response" automatically
		// throwing here sends "error" automatically
	}
);

// Called whenever the request's lifecycle ends — explicit cancel, disconnect timeout, or
// the client resubscribing on a different instance (see Scaling below). A successful
// response does NOT end the lifecycle by itself — the reply topic stays subscribed
// until the client calls cancel(), so late replies can still be sent after "response".
server.onDispose("users:get:[id]", (connectionId, requestId) => {
	cancelExpensiveJob(requestId);
});
```

In a handler, `reply` only covers custom keys defined in the route's `replies` config. The `"response"` and `"error"` built-ins are handled implicitly — use `return` to send the response, `throw` to send an error.

`signal` is an `AbortSignal` scoped to the request. It's created before the handler runs, so there's no race between disposal and the handler having set anything up — check `signal.aborted` or listen for `"abort"` to bail out early from long-running work. It always aborts before `onDispose` fires for the same request, so `onDispose` can rely on the handler having already stopped.

### Emitting data

```ts
server.emit("chat:[roomId]", {
	params: { roomId: "general" },
	data: "new message"
});
```

### Sending replies from outside a handler

```ts
const reply = server.reply("users:get:[id]", requestId);
reply("progress", "Still loading..."); // custom reply
reply("response", { name: user.name }); // built-in: sends the final response
reply("error", "Something went wrong"); // built-in: sends an error
```

Unlike the handler's `reply`, `server.reply()` includes the `"response"` and `"error"` built-ins explicitly, since there's no `return`/`throw` to fall back on.

### Middlewares

Middlewares run before every RPC handler and data subscription. Use them for auth, logging, or attaching extra context:

```ts
const authMiddleware: Middleware<Context, Meta> = async ({
	meta,
	context,
	next
}) => {
	if (meta?.roles && !meta.roles.includes(context.role)) {
		throw new Error("Forbidden");
	}
	return next();
};

// Attach extra fields to context for downstream middlewares and handlers
const tenantMiddleware: Middleware<Context, Meta> = async ({
	context,
	next
}) => {
	const tenant = await db.getTenant(context.userId);
	return next({ context: { tenant } }); // merged shallowly into context
};
```

- Must call `next()` exactly once — not calling it short-circuits the request (auto-error for RPC, subscribe-rejected for data)
- `next({ context })` shallow-merges new fields into `context` for the rest of the chain; it does not affect the base connection context

## Client

```ts
const client = router.buildClient({
	transport, // required — WaycastClientTransport
	codec, // optional — default: JSON
	logger: console // optional
});
```

### RPC call

```ts
const cancel = client.rpc("users:get:[id]", {
	params: { id: "42" },
	payload: { includeProfile: true },
	callbacks: {
		progress: (msg) => console.log(msg),
		response: (user) => console.log(user.name),
		error: (err) => console.error(err)
	}
});

// Always call this once you're done with the request — including after a successful
// response — to unsubscribe from the reply topic and let the server dispose it.
// Without it, the server-side session (and onDispose) stays alive until the client
// disconnects and the disconnect grace period elapses.
cancel();
```

### Subscribing to data

```ts
const unsub = client.onData("chat:[roomId]", {
	params: { roomId: "general" },
	callback: (msg) => console.log(msg)
});

// Unsubscribe
unsub();
```

Multiple `onData` calls for the same resolved topic share a single subscription. The server unsubscribe is sent only when the last listener unsubscribes.

The client automatically resubscribes to all active data topics and pending RPC reply topics after a reconnect (within `maxDisconnectionDuration`).

## Transport

The transport is the bridge between Waycast and the actual network layer. Waycast ships no built-in transports — you wire one up yourself. It's a small interface:

```ts
interface WaycastServerTransport<Context> {
	start(handlers: {
		onConnection: (connectionId: string, context: Context) => void;
		onMessage: (connectionId: string, raw: string) => void;
		onDisconnection: (connectionId: string) => void;
	}): void | Promise<void>;
	send(connectionId: string, raw: string): void;
	disconnect(connectionId: string): void;
	stop(): void | Promise<void>;
}

interface WaycastClientTransport {
	connect(handlers: {
		onOpen: () => void;
		onMessage: (raw: string) => void;
		onClose: () => void;
	}): void | Promise<void>;
	send(raw: string): void;
	disconnect(): void;
}
```

`Context` is resolved by the server transport before `onConnection` fires — a connection whose context resolution throws is closed immediately and never reaches Waycast.

## Scaling

By default, Waycast uses in-memory implementations for the adapter and disposal scheduler. Both are correct for a single-process deployment. For horizontal scaling, swap them out independently.

### Adapter

The adapter backs Waycast's pub/sub system. The default is in-memory; for multi-instance deployments, use a Redis-backed implementation:

```ts
interface WaycastAdapter {
	subscribe(connectionId: string, topic: string): void | Promise<void>;
	unsubscribe(connectionId: string, topic: string): void | Promise<void>;
	publish(topic: string, raw: string): void | Promise<void>;
	onMessage(handler: (topic: string, raw: string) => void): void;
}
```

`onMessage` is how Waycast delivers inbound messages to locally-connected sockets. An adapter that does its own full delivery (like the Socket.io adapter below) should make this a no-op to avoid double-delivery.

### Disposal Scheduler

The disposal scheduler ensures `onDispose` fires exactly once cluster-wide after a client disconnects and doesn't reconnect within `maxDisconnectionDuration`. The default is in-memory; use a queue-backed implementation for multi-instance:

```ts
interface WaycastDisposalScheduler {
	schedule(key: string, delayMs: number): void | Promise<void>;
	cancel(key: string): void | Promise<void>;
	onDue(handler: (key: string) => void): void;
}
```

Example with BullMQ:

```ts
import { Queue, Worker } from "bullmq";

function createBullMQDisposalScheduler(
	connection,
	queueName = "waycast-disposal"
) {
	const queue = new Queue(queueName, { connection });
	return {
		async schedule(key, delayMs) {
			await (await queue.getJob(key))?.remove();
			await queue.add(
				key,
				{},
				{ jobId: key, delay: delayMs, removeOnComplete: true }
			);
		},
		async cancel(key) {
			await (await queue.getJob(key))?.remove();
		},
		onDue(handler) {
			new Worker(queueName, async (job) => handler(job.id), { connection });
		}
	};
}
```

### Cross-instance disposal

If a client reconnects to a different instance (e.g. behind a non-sticky load balancer) and resubscribes to a still-pending RPC's reply topic, the new instance won't have that request locally — only the instance that originally received the `"rpc"` message does, since the handler itself is a live closure running there. In that case, the new instance broadcasts an abandonment over the adapter so the owning instance disposes immediately (aborting `signal` and firing `onDispose`) instead of waiting out the full `maxDisconnectionDuration`. This needs a real distributed adapter (Redis, NATS, ...); with the in-memory adapter both "instances" are the same process anyway.

## Examples

### WebSocket

```ts
// transport.ts
import { WebSocketServer } from "ws";
import type { WaycastServerTransport, WaycastClientTransport } from "waycast";

function createWebSocketServerTransport<Context>(
	port: number,
	createContext: (req: IncomingMessage) => Context | Promise<Context>
): WaycastServerTransport<Context> {
	const wss = new WebSocketServer({ port });
	const connections = new Map<string, WebSocket>();

	return {
		start({ onConnection, onMessage, onDisconnection }) {
			wss.on("connection", async (ws, req) => {
				const connectionId = crypto.randomUUID();
				connections.set(connectionId, ws);
				let context: Context;
				try {
					context = await createContext(req);
				} catch {
					connections.delete(connectionId);
					ws.close();
					return;
				}
				onConnection(connectionId, context);
				ws.on("message", (raw) => onMessage(connectionId, raw.toString()));
				ws.on("close", () => {
					connections.delete(connectionId);
					onDisconnection(connectionId);
				});
			});
		},
		send(connectionId, raw) {
			connections.get(connectionId)?.send(raw);
		},
		disconnect(connectionId) {
			connections.get(connectionId)?.close();
		},
		stop() {
			wss.close();
		}
	};
}

function createWebSocketClientTransport(url: string): WaycastClientTransport {
	let ws: WebSocket;
	return {
		connect({ onOpen, onMessage, onClose }) {
			ws = new WebSocket(url);
			ws.onopen = () => onOpen();
			ws.onmessage = (e) => onMessage(e.data);
			ws.onclose = () => onClose();
		},
		send(raw) {
			ws.send(raw);
		},
		disconnect() {
			ws.close();
		}
	};
}
```

```ts
// server.ts
const server = router.buildServer<Context>({
	transport: createWebSocketServerTransport(8080, async (req) => {
		const user = await verifyToken(req.headers.authorization);
		return { userId: user.id, role: user.role };
	})
});
```

```ts
// client.ts
const client = router.buildClient({
	transport: createWebSocketClientTransport("ws://localhost:8080")
});
```

### Socket.io

The Socket.io adapter delegates subscribe/publish directly to rooms, so Waycast's `onMessage` handler is intentionally a no-op — socket.io already did full delivery.

```ts
// adapter.ts
import type { WaycastAdapter } from "waycast";

function createSocketIOAdapter(io: Server): WaycastAdapter {
	return {
		subscribe(connectionId, topic) {
			io.sockets.sockets.get(connectionId)?.join(topic);
		},
		unsubscribe(connectionId, topic) {
			io.sockets.sockets.get(connectionId)?.leave(topic);
		},
		publish(topic, raw) {
			io.to(topic).emit("message", raw);
		},
		onMessage() {} // no-op — socket.io already delivered above
	};
}
```

```ts
// transport.ts
import type { WaycastServerTransport, WaycastClientTransport } from "waycast";

function createSocketIOServerTransport<Context>(
	io: Server,
	createContext: (handshake: Socket["handshake"]) => Context | Promise<Context>
): WaycastServerTransport<Context> {
	return {
		start({ onConnection, onMessage, onDisconnection }) {
			io.on("connection", async (socket) => {
				let context: Context;
				try {
					context = await createContext(socket.handshake);
				} catch {
					socket.disconnect(true);
					return;
				}
				onConnection(socket.id, context);
				socket.on("message", (raw) => onMessage(socket.id, raw));
				socket.on("disconnect", () => onDisconnection(socket.id));
			});
		},
		send(connectionId, raw) {
			io.to(connectionId).emit("message", raw);
		},
		disconnect(connectionId) {
			io.sockets.sockets.get(connectionId)?.disconnect(true);
		},
		stop() {
			io.close();
		}
	};
}

function createSocketIOClientTransport(url: string): WaycastClientTransport {
	let socket: ReturnType<typeof ioClient>;
	return {
		connect({ onOpen, onMessage, onClose }) {
			socket = ioClient(url);
			socket.on("connect", () => onOpen());
			socket.on("message", (raw) => onMessage(raw));
			socket.on("disconnect", () => onClose());
		},
		send(raw) {
			socket.emit("message", raw);
		},
		disconnect() {
			socket.disconnect();
		}
	};
}
```

```ts
// server.ts
const io = new Server(8080);
// io.adapter(createAdapter(pubClient, subClient)); // optional: @socket.io/redis-adapter for horizontal scaling

const server = router.buildServer<Context>({
	transport: createSocketIOServerTransport(io, async (handshake) => {
		const user = await verifyToken(handshake.auth.token);
		return { userId: user.id, role: user.role };
	}),
	adapter: createSocketIOAdapter(io)
	// pass createBullMQDisposalScheduler(...) here for multi-instance deployments
});
```

```ts
// client.ts
const client = router.buildClient({
	transport: createSocketIOClientTransport("http://localhost:8080")
});
```

## License

MIT
