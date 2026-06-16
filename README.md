<h1 align="center">Waycast</h1>

<p align="center">
  <strong>Transport-agnostic, end-to-end typed RPC &amp; Pub/Sub for TypeScript.</strong><br/>
  Bring your own network layer. Waycast handles the typing, validation, and routing.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/waycast"><img src="https://img.shields.io/npm/v/waycast?style=flat-square&color=6366f1" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/waycast"><img src="https://img.shields.io/npm/dm/waycast?style=flat-square&color=6366f1" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT License" />
</p>

---

Waycast is a **transport-agnostic**, end-to-end typed RPC and Pub/Sub framework for TypeScript. Built on top of [TypeBox](https://github.com/sinclairzx81/typebox), it provides rigorous runtime schema validation, aggressive type inference, and native support for **intermediate RPC streams** (progress updates, logs, etc.) before a final response — with zero lock-in to any particular network technology.

## Table of Contents

- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [1. Define your Router](#1-define-your-router)
  - [2. Setup the Server](#2-setup-the-server)
  - [3. Setup the Client](#3-setup-the-client)
- [Router Composition & Merging](#router-composition--merging)
- [Disconnected RPC Replies](#disconnected-rpc-replies)
- [Utility Types (Custom Hooks)](#utility-types-custom-hooks)
- [API Reference](#api-reference)
- [Comparison](#comparison)
- [Contributing](#contributing)
- [License](#license)

---

## Features

| Feature | Description |
|---|---|
| 🔌 **Transport Agnostic** | Works with Socket.io, native WebSockets, WebRTC, cross-window messaging, or anything else |
| 🔒 **Strictly Typed** | End-to-end type inference from schema → server handler → client call |
| ✅ **Auto-Validated** | Payloads are compiled and validated via TypeBox before reaching your handler |
| 📡 **Intermediate Replies** | Stream progress updates, logs, or partial results during a single RPC call |
| 🔗 **Disconnected RPCs** | Resolve, push, or reject an RPC from anywhere outside the handler context |
| 📬 **Pub/Sub Routing** | First-class support for typed data topics with automatic subscribe/unsubscribe |
| 🧹 **Lifecycle Hooks** | `onDispose` lets you clean up resources when a client drops mid-RPC |
| 🔇 **Fire-and-Forget** | Mark an RPC with `Type.Void()` to skip sending any response over the wire |
| 🧩 **Composable** | Split large routers into domain modules and merge them with full type inference |

---

## How It Works

Waycast introduces a clean three-layer architecture:

```
┌────────────────────────────────────────────────────────────────────┐
│                          Router (Schema)                           │
│     Shared between client & server. Defines all RPC routes and     │
│               Pub/Sub topics using TypeBox schemas.                │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │
          ┌── buildServer() ──────┴────── buildClient() ──┐
          ▼                                               ▼
┌──────────────────────────┐                    ┌──────────────────────────┐
│        ServerApp         │                    │        ClientApp         │
├──────────────────────────┤                    ├──────────────────────────┤
│ [RPC]                    │                    │ [RPC]                    │
│  .on(route, handler)     │                    │  .rpc(route) => dispose  │
│                          │                    │                          │
│ [Pub/Sub]                │                    │ [Pub/Sub]                │
│  .emit(topic, data)      │                    │  .onData(topic)=> dispose│
│                          │                    │                          │
│ [Incoming]               │                    │ [Incoming]               │
│  .handle(connId, msg)    │                    │  .handleData(msg)        │
└─────────┬────────────────┘                    └────────────────┬─────────┘
          │                                                      │
          ▼                                                      ▼
┌──────────────────────────┐                    ┌──────────────────────────┐
│      Server Adapter      │                    │      Client Adapter      │
├──────────────────────────┤                    ├──────────────────────────┤
│ - ACK System             │◄─── (Req ID) ─────►│ .send(msg) => string (ID)│
│ - Reply/Error Callbacks  │                    │ .subscribe([topics])     │
│                          │                    │ .unsubscribe([topics])   │
└─────────┬────────────────┘                    └────────────────┬─────────┘
          │                                                      │
          └─────────────────────────┬────────────────────────────┘
                                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                          Transport Layer                           │
│               (Socket.io, WebSocket, WebRTC, etc.)                 │
└────────────────────────────────────────────────────────────────────┘
```

1. **You define** your RPC routes and Pub/Sub topics once in a shared `Router`.
2. **You provide** thin adapter functions that tell Waycast how to send/receive messages over your chosen transport.
3. **Waycast handles** schema compilation, payload validation, routing, and reply tracking automatically.

---

## Installation

```bash
npm install waycast typebox
# or
bun add waycast typebox
```

---

## Quick Start

### 1. Define your Router

Define your shared schema using TypeBox. This file is typically shared between your client and server (e.g. in a monorepo package or a `shared/` directory).

```typescript
// router.ts
import { Type as t } from "@sinclair/typebox";
import { Router } from "waycast";

export interface Context { userId?: string; }
export interface Meta { requireAuth?: boolean; }

export const appRouter = new Router<Meta>()
  // A typed Pub/Sub data stream
  .data("system:alerts", t.String())

  // An RPC with intermediate reply streams
  .rpc("job:[jobId]:process", {
    payload: t.Object({ force: t.Boolean() }),
    replies: {
      progress: t.Object({ percent: t.Number() }),
      log: t.String(),
    },
    response: t.Boolean(),
    meta: { requireAuth: true },
  })

  // A fire-and-forget RPC (no response sent)
  .rpc("metrics:ping", {
    payload: t.Object({ timestamp: t.Number() }),
    meta: { requireAuth: false },
    // replies and response are omitted, defaulting to {} and t.Void()
  });

export type AppRouter = typeof appRouter;
```

**Topic Parameters**: Use `[paramName]` in route/topic strings to define dynamic segments. Waycast automatically extracts them as typed parameters:

```
"job:[jobId]:process"  →  params: { jobId: string }
"user:[userId]:status" →  params: { userId: string }
```

---

### 2. Setup the Server

Here is a complete example using [Socket.io](https://socket.io/). The pattern is the same for any other transport.

**Step 1 — Strictly type your Socket.io server:**

```typescript
import { Server } from "socket.io";
import type {
  RequestMessage,
  DataMessage,
  RpcReplyMessage,
  InferDataRoutes,
  InferRpcRoutes,
  BuiltInRpcRoutes,
} from "waycast";
import { type AppRouter } from "./router";

type MyDataRoutes = InferDataRoutes<AppRouter>;
type MyRpcRoutes  = InferRpcRoutes<AppRouter> & BuiltInRpcRoutes;

const io = new Server<
  { rpc: (message: RequestMessage<MyRpcRoutes>) => void },
  { data: (message: DataMessage<MyDataRoutes>) => void; reply: (message: RpcReplyMessage<MyRpcRoutes>) => void }
>(3000);
```

**Step 2 — Build the Waycast server adapter:**

Tell Waycast how to subscribe/unsubscribe connections and how to transmit messages over your transport layer.

```typescript
const server = appRouter.buildServer<Context>({
  topic: {
    subscribe:   (connId, ...topics) => io.sockets.sockets.get(connId)?.join(topics),
    unsubscribe: (connId, ...topics) => topics.forEach(t => io.sockets.sockets.get(connId)?.leave(t)),
    hasSubscriber: (topic) => (io.sockets.adapter.rooms.get(topic)?.size ?? 0) > 0,
  },
  isClientConnected: (connId) => io.sockets.sockets.has(connId),
  emit:  (topic, message) => io.to(topic).emit("data", message),
  reply: (topic, message) => io.to(topic).emit("reply", message),
  // Optional: Custom error formatting for client replies
  errorFormatter: (err) => err instanceof Error ? err.message : String(err),
  // Optional: Logger adapter (e.g. console, pino, etc.)
  logger: console,
});
```

**Step 3 — Register RPC handlers:**

```typescript
server
  .on("job:[jobId]:process", async (ctx) => {
    const { jobId } = ctx.params;   // Fully typed: { jobId: string }
    const { force } = ctx.payload;  // Fully typed: { force: boolean }

    ctx.reply("log", `Starting job ${jobId}`);
    ctx.reply("progress", { percent: 50 });
    // ...
    return true; // Final response automatically sent to the client
  })
  .onDispose("job:[jobId]:process", (connectionId, requestId) => {
    // Called automatically when the client disconnects mid-RPC
    console.log(`Cleaning up request ${requestId} for connection ${connectionId}`);
  });
```

**Step 4 — Hook up the socket:**

```typescript
// Clean up lingering RPCs when a socket leaves a room
io.of("/").adapter.on("leave-room", (room, id) => {
  server.handleUnsubscribe(id, room);
});

io.on("connection", (socket) => {
  socket.on("rpc", (message) => {
    server.handle(socket.id, message, async (meta) => {
      // meta is typed as your Meta interface: { requireAuth?: boolean }
      // Use it to authenticate, then return the Context object for your handler
      return { userId: "user-123" };
    });
  });
});
```

**Emitting Pub/Sub data from the server:**

```typescript
// Type-safe: name, params, and data are all inferred from the schema
server.emit("system:alerts", {
  data: "System is going down for maintenance!",
});
```

---

### 3. Setup the Client

**Step 1 — Build the Waycast client adapter:**

```typescript
import { io } from "socket.io-client";
import { appRouter } from "./router";

const socket = io("http://localhost:3000");

const client = appRouter.buildClient({
  send: (message) => {
    socket.emit("rpc", message);
  },
  // Optional: Logger adapter (e.g. console, pino, etc.)
  logger: console,
});
```

**Step 2 — Hook up incoming message handlers:**

```typescript
socket.on("data",  (msg) => client.handleData(msg));
socket.on("reply", (msg) => client.handleReply(msg));

socket.on("disconnect", () => client.handleDisconnect());
socket.io.on("reconnect", () => client.resubscribe());
```

**Step 3 — Call RPCs & subscribe to data streams:**

```typescript
socket.on("connect", () => {
  // Subscribe to a Pub/Sub topic. Automatically sends a subscribe message
  // and returns an unsubscribe function for cleanup.
  const unsubscribe = client.onData("system:alerts", {
    callback: (msg) => {
      console.log(`Alert: ${msg}`); // `msg` is typed as `string`
    },
  });

  // Call an RPC with full type safety
  const cancel = client.rpc("job:[jobId]:process", {
    params: { jobId: "backup-42" },       // params, typed as { jobId: string }
    payload: { force: true },             // payload, typed as { force: boolean }
    callbacks: {
      log:      (msg) => console.log(msg),               // typed as string
      progress: (p)   => console.log(`${p.percent}%`),  // typed as { percent: number }
      response: (res) => console.log(`Done: ${res}`),   // typed as boolean
      error:    (err) => console.error(err),
    },
  });

  // `cancel()` cancels the local listener; `unsubscribe()` unsubscribes the data topic
});
```

---

## Router Composition & Merging

Waycast cleanly separates your **schemas** (`Router`) from your **implementation** (`ServerApp`). This allows you to split large applications into domain-driven modules while preserving 100% type inference.

**Splitting schemas with `.merge()`:**

```typescript
// users.router.ts
export const userRouter = new Router<Meta>()
  .data("user:[userId]:status", t.String())
  .rpc("user:create", { /* ... */ });

// posts.router.ts
export const postRouter = new Router<Meta>()
  .rpc("post:like", { /* ... */ });

// app.router.ts
export const appRouter = new Router<Meta>()
  .merge(userRouter)
  .merge(postRouter);

export type AppRouter = typeof appRouter;
```

**Splitting handler implementations into controller modules:**

```typescript
// app.router.ts
export type AppServer = ReturnType<typeof appRouter.buildServer<Context>>;

// controllers/user.controller.ts
import type { AppServer } from "../app.router";

export function registerUserHandlers(server: AppServer) {
  // Autocomplete knows about "user:create" and its fully-typed payload!
  server.on("user:create", async (ctx) => {
    console.log("Creating user:", ctx.payload);
  });
}

// server.ts
const server = appRouter.buildServer<Context>(adapters);
registerUserHandlers(server);
```

---

## Handling Client Disconnects

When clients drop connection due to network instability, Waycast can gracefully debounce the disposal of their active RPCs, giving them a brief window to reconnect and resume where they left off.

To enable this, configure the `maxDisconnectionDuration` on your Router:

```typescript
export const appRouter = new Router<Meta>({
  maxDisconnectionDuration: 5000, // 5 seconds
});
```

When a client drops, simply call `server.handleUnsubscribe(connectionId, topic)`. Waycast then checks if a `disposal: { schedule, cancel }` adapter was provided:
- **In-Memory Tracking (Single Node)**: If no disposal adapter is provided, Waycast gracefully falls back to an internal, debounced `setTimeout`. This is perfect for single-instance deployments.
- **Distributed Queues**: For horizontally scaled setups, implement the `disposal` adapter to push the timeout to a Redis/BullMQ delayed queue. When the delayed job runs, invoke `server.executeDispose(connectionId, topic)`.

If the client reconnects within the threshold and resubscribes, the disposal is automatically cancelled!

---

## Disconnected RPC Replies

Sometimes you need to resolve an RPC from outside its handler — for example, after a background job completes, or from a webhook callback. Use `server.reply()`, `server.replyResponse()`, and `server.replyError()` for this:

```typescript
// Stash the requestId when the RPC comes in
const pendingJobs = new Map<string, string>(); // jobId → requestId

server.on("job:[jobId]:process", async (ctx) => {
  pendingJobs.set(ctx.params.jobId, ctx.requestId);
  // Don't return anything here — the response will come later
});

// Resolve from a webhook or event listener
function onJobComplete(jobId: string, success: boolean) {
  const requestId = pendingJobs.get(jobId);
  if (!requestId) return;

  // Send an intermediate reply
  server.reply("job:[jobId]:process", requestId)("progress", { percent: 100 });

  // Send the final response
  server.replyResponse("job:[jobId]:process", requestId, success);

  pendingJobs.delete(jobId);
}

// Or send an error
function onJobFailed(jobId: string, message: string) {
  const requestId = pendingJobs.get(jobId);
  if (!requestId) return;
  server.replyError("job:[jobId]:process", requestId, message);
  pendingJobs.delete(jobId);
}
```

---

## Utility Types (Custom Hooks)

Waycast exports powerful generic utilities designed to help you build strictly-typed framework wrappers (e.g. React/Vue hooks). By extracting types directly from your `AppRouter`, your UI layer gets the same aggressive type-safety as the core library.

```typescript
import { useState, useEffect } from "react";
import type { Static } from "@sinclair/typebox";
import type { InferDataRoutes, ParamsOf } from "waycast";
import type { AppRouter } from "./app.router";
import { client } from "./client";

type DataRoutes = InferDataRoutes<AppRouter>;

// A custom React Hook with full end-to-end type safety
export function useWaycastData<T extends Extract<keyof DataRoutes, string>>(
  topic: T,
  params: ParamsOf<T>,
): Static<DataRoutes[T]> | undefined {
  const [data, setData] = useState<Static<DataRoutes[T]>>();

  useEffect(() => {
    // Automatically subscribes on mount, unsubscribes on unmount
    return client.onData(topic, {
      params,
      callback: (newData) => setData(newData),
    });
  }, [topic, JSON.stringify(params)]); // Stringify params to stabilize the dep

  return data;
}

// Usage in a component — fully typed at every step!
const status = useWaycastData("user:[userId]:status", { userId: "123" });
//    ^ string | undefined
```

---

## API Reference

### `new Router<Meta>()`

The chainable schema builder. Shared between client and server.

| Method | Signature | Description |
|---|---|---|
| `.data()` | `(name, schema)` | Register a typed Pub/Sub data topic |
| `.rpc()` | `(name, { payload, replies, response, meta })` | Register a typed RPC route |
| `.merge()` | `(otherRouter)` | Merge another router's routes into this one |
| `.buildServer()` | `<Context>(adapters)` → `ServerApp` | Build a server adapter with the given transport hooks |
| `.buildClient()` | `(adapters)` → `ClientApp` | Build a client adapter with the given transport hooks |

---

### `ServerApp<Context, ...>`

Returned by `router.buildServer()`.

| Method | Signature | Description |
|---|---|---|
| `.on()` | `(name, handler)` → `this` | Register an RPC handler. Chainable. |
| `.onDispose()` | `(name, handler)` → `this` | Register a cleanup handler called when client disconnects mid-RPC. Chainable. |
| `.emit()` | `(name, { params?, data })` | Publish a typed message to a Pub/Sub topic |
| `.handle()` | `(connectionId, message, middleware?)` | Route an incoming message. Call this from your transport listener. |
| `.handleUnsubscribe()` | `(connId, topic)` | Trigger disposal for a dropped reply topic. Call on `leave-room` / disconnect. |
| `.executeDispose()` | `(connId, topic)` | Executes a scheduled dispose handler from an external delayed queue. |
| `.reply()` | `(name, requestId)` → `(type, data) => void` | Send an intermediate reply from outside the handler context |
| `.replyResponse()` | `(name, requestId, data)` | Send the final response from outside the handler context |
| `.replyError()` | `(name, requestId, error)` | Send an error from outside the handler context |

**Handler context (`ctx`) object:**

| Property | Type | Description |
|---|---|---|
| `ctx.connectionId` | `string` | The connection identifier for this socket/client |
| `ctx.requestId` | `string` | The unique ID for this RPC invocation |
| `ctx.params` | `ParamsOf<Name>` | Extracted route parameters (typed) |
| `ctx.payload` | `Static<Payload>` | Validated request payload (typed) |
| `ctx.context` | `Context` | The context object returned by your middleware |
| `ctx.reply()` | `(type, data) => void` | Send an intermediate reply to the client |

---

### `ClientApp<...>`

Returned by `router.buildClient()`.

| Method | Signature | Description |
|---|---|---|
| `.rpc()` | `(name, { params?, payload, callbacks })` → `() => void` | Call an RPC. Returns a cancel function. |
| `.onData()` | `(name, { params?, callback })` → `() => void` | Subscribe to a data topic. Returns an unsubscribe function. Auto-manages ref counts. |
| `.handleData()` | `(message)` | Feed an incoming data message into Waycast. Call from your transport listener. |
| `.handleReply()` | `(message)` | Feed an incoming reply message into Waycast. Call from your transport listener. |
| `.handleDisconnect()` | `()` | Records disconnect time. Call on transport `disconnect`. |
| `.resubscribe()` | `()` | Re-subscribe to all active topics. Useful after a reconnect. |
| `.clear()` | `()` | Unsubscribe all topics and clear all listeners and pending RPC callbacks. |

---

### Exported Types

| Type | Description |
|---|---|
| `InferDataRoutes<Router>` | Extracts the `DataRoutes` map from a `Router` type |
| `InferRpcRoutes<Router>` | Extracts the `RpcRoutes` map from a `Router` type |
| `ParamsOf<RouteString>` | Extracts dynamic `[param]` segments from a route string as `{ param: string }` |
| `RequestMessage<RpcRoutes>` | The wire format for an incoming RPC message (for typing your transport server) |
| `DataMessage<DataRoutes>` | The wire format for an outgoing Pub/Sub message (for typing your transport server) |
| `RpcReplyMessage<RpcRoutes>` | The wire format for an RPC reply message (for typing your transport server) |
| `ServerAdapters<...>` | The adapter interface you implement to connect Waycast to your transport. Includes `topic`, `emit`, `reply`, `isClientConnected`, optional `disposal` scheduling, `errorFormatter`, and `logger`. |
| `ClientAdapters<...>` | The adapter interface you implement on the client side (includes `send` and optional `logger`) |
| `BuiltInRpcRoutes` | Type for the built-in `_waycast:subscribe` / `_waycast:unsubscribe` routes |
| `RpcContext<...>` | The type of the `ctx` object passed to your RPC handler |
| `RpcDef<...>` | The type of a single RPC route definition |

---

## Comparison

| Feature | Waycast | tRPC | socket.io (raw) |
|---|:---:|:---:|:---:|
| Single-schema type inference¹ | ✅ | ✅ | ⚠️ |
| Transport agnostic | ✅ | ⚠️² | ❌ |
| Pub/Sub with typed topics | ✅ | ⚠️³ | ⚠️ |
| Intermediate reply streams | ✅ | ⚠️⁴ | ❌ |
| Runtime payload validation | ✅ | ✅ | ❌ |
| Disconnected RPC replies | ✅ | ❌ | ❌ |
| Dynamic route parameters | ✅ | ❌ | ❌ |
| Framework agnostic | ✅ | ✅ | ✅ |

> ¹ Socket.io has TypeScript support, but types must be declared manually on both client and server independently. Waycast and tRPC derive all types from a single shared schema automatically.
>
> ² tRPC provides adapters for common runtimes (Node, Bun, fetch) but is fundamentally tied to HTTP/WebSocket — you cannot plug in an arbitrary transport layer.
>
> ³ tRPC supports subscriptions over WebSocket, but not named Pub/Sub topics with dynamic parameters.
>
> ⁴ tRPC v11 supports streaming responses, but the model is different — Waycast's intermediate replies are named, typed, and dispatched alongside a final response in a single RPC call.

---

## Contributing

Contributions, bug reports, and feature requests are welcome!

**Setup:**

```bash
git clone https://github.com/your-username/waycast.git
cd waycast
bun install
```

**Build:**

```bash
bun run build
```

**Run examples:**

```bash
cd examples/socket.io
bun install
bun run dev
```

**Code style:**

This project uses [Biome](https://biomejs.dev/) for linting and formatting. A pre-commit hook is set up via Husky to run checks automatically. You can also run it manually:

```bash
bunx biome check --write .
```

Please open an issue before submitting a large PR so we can align on the design first.

---

## License

[MIT](./LICENSE)
