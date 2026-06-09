# Waycast

Waycast is a transport-agnostic, end-to-end typed RPC and Pub/Sub framework for TypeScript. Built heavily on [TypeBox](https://github.com/sinclairzx81/typebox), it provides rigorous runtime schema validation, flawless developer experience with aggressive type inference, and native support for intermediate RPC streams (like progress updates or logs) before a final response.

## Features

- **Transport Agnostic**: Bring your own network layer! Waycast is designed to sit on top of Socket.io, native WebSockets, WebRTC, or even cross-window message passing.
- **Strictly Typed & Auto-Validated**: Built-in generic interfaces perfectly map your schemas to your adapter layer. By integrating `@sinclair/typebox/compile`, Waycast instantly validates and rejects malformed payloads natively before they hit your business logic.
- **Intermediate RPC Replies**: Send progressive updates (e.g., download progress, streaming logs) back to the client during a single RPC execution.
- **Disconnected RPC Handlers**: Resolve promises, push intermediate data, or throw errors completely outside the standard handler context using `server.reply(...)`, `server.replyResponse(...)`, and `server.replyError(...)`.
- **Pub/Sub Routing**: Provide first-class support for subscribing/unsubscribing to strictly-typed data topics (e.g. `user:123:status`). Waycast routes the intent to your chosen transport layer while guaranteeing deterministic topic strings on the fly for safe routing.
- **Lifecycle Hooks**: Provides an `onDispose` hook to manually clean up resources (like clearing intervals or aborting external requests) if a client drops mid-RPC.
- **Fire-and-Forget**: RPCs can be marked with `Type.Void()` and return `undefined` to cleanly terminate without transmitting any redundant responses over the wire.

## Installation

```bash
npm install waycast typebox
# or
bun add waycast typebox
```

## Quick Start

### 1. Define your Router

Define your shared schema using TypeBox. This file can be shared between your client and server.

```typescript
import { Type as t } from "typebox";
import { Router } from "waycast";

export interface Context { userId?: string; }
export interface Meta { requireAuth?: boolean; }

export const appRouter = new Router<Meta>()
  // Define a Data Stream (Pub/Sub)
  .data("system:alerts", t.String())
  
  // Define an RPC Route
  .rpc("job:[jobId]:process", {
    payload: t.Object({ force: t.Boolean() }),
    replies: {
      progress: t.Object({ percent: t.Number() }),
      log: t.String()
    },
    response: t.Boolean(),
    meta: { requireAuth: true }
  })
  
  // Define a Fire-And-Forget RPC
  .rpc("metrics:ping", {
    payload: t.Object({ timestamp: t.Number() }),
    replies: {},
    response: t.Void(), // No response will be sent back
    meta: { requireAuth: false }
  });

export type AppRouter = typeof appRouter;
```

### 2. Setup the Server

Waycast requires you to adapt its input/output to your chosen network layer. Here is an example using `socket.io`.

**Step 1: Setup strict Typing for Socket.io**
Extract your router types to strictly type the underlying generic `Server`.
```typescript
import { Server } from "socket.io";
import { appRouter, type AppRouter, type Context } from "./router";
import type { RequestMessage, DataMessage, RpcReplyMessage, InferDataRoutes, InferRpcRoutes, BuiltInRpcRoutes } from "waycast";

type MyDataRoutes = InferDataRoutes<AppRouter>;
type MyRpcRoutes = InferRpcRoutes<AppRouter> & BuiltInRpcRoutes;

const io = new Server<{
  rpc: (message: RequestMessage<MyRpcRoutes>, ack: (requestId: string) => void) => void;
}, {
  data: (message: DataMessage<MyDataRoutes>) => void;
  reply: (message: RpcReplyMessage<MyRpcRoutes>) => void;
}>(3000);
```

**Step 2: Build the Waycast Server Adapter**
Tell Waycast how to transmit and subscribe to your specific network transport layer.
```typescript
const server = appRouter.buildServer<Context>({
  topic: {
    subscribe: (connId, ...topics) => io.sockets.sockets.get(connId)?.join(topics),
    unsubscribe: (connId, ...topics) => topics.forEach(t => io.sockets.sockets.get(connId)?.leave(t))
  },
  emit: (topic, message) => io.to(topic).emit("data", message),
  reply: (topic, message) => io.to(topic).emit("reply", message)
});
```

**Step 3: Register RPC Handlers**
Implement your business logic. Payloads are automatically validated before they hit your handler!
```typescript
server.on("job:[jobId]:process", async (ctx) => {
  const { jobId } = ctx.params; // Fully Typed! { jobId: string }
  const { force } = ctx.payload; // Fully Typed! { force: boolean }

  // Send progressive intermediate replies during the RPC!
  ctx.reply("log", `Starting job ${jobId}`);
  ctx.reply("progress", { percent: 50 });

  return true; // Final response automatically sent
})
.onDispose("job:[jobId]:process", (requestId) => {
  console.log(`Clean up request ${requestId} resources!`);
});
```

**Step 4: Hook up the Socket**
Listen to the socket and pass the raw payload into Waycast. Waycast handles the validation and routing!
```typescript
// Clean up lingering RPCs when sockets leave rooms (or disconnect)
io.of("/").adapter.on("leave-room", (room, id) => {
  if (room.endsWith("|reply")) server.handleDispose(room);
});

io.on("connection", (socket) => {
  socket.on("rpc", (message, ack) => {
    const requestId = Math.random().toString(36).slice(2);
    if (ack) ack(requestId); 

    // Pass the message into Waycast
    server.handle(socket.id, requestId, message, async (meta) => {
      return { userId: "user-123" }; // Injects Context into the handler!
    });
  });
});
```

### 3. Setup the Client

**Step 1: Build the Waycast Client Adapter**
Map your socket's `emit` to Waycast's `send` function.

```typescript
import { io, Socket } from "socket.io-client";
import { appRouter, type AppRouter } from "./router";

const socket = io("http://localhost:3000");

const client = appRouter.buildClient({
  send: (message) => {
    return new Promise((resolve) => {
      socket.emit("rpc", message, (requestId) => {
        resolve(requestId); // Resolve the Promise when Server ACKs
      });
    });
  }
});
```

**Step 2: Hook up Socket Listeners**
Pipe raw incoming messages into Waycast for decoding and typing.
```typescript
socket.on("data", (msg) => client.handleData(msg));
socket.on("reply", (msg) => client.handleReply(msg));
```

**Step 3: Call RPCs & Subscribe**
Enjoy end-to-end type safety across the network!
```typescript
socket.on("connect", () => {
  // Automatically Subscribe to Data Streams
  // Listens dynamically based on the topic string rather than tracking raw JSON blobs.
  client.onData("system:alerts", undefined, (msg) => {
    console.log(`Alert: ${msg}`); // Strongly typed to string
  });

  // Call an RPC
  client.rpc("job:[jobId]:process", { jobId: "backup" }, { force: true }, {
    log: (msg) => console.log(msg),
    progress: (p) => console.log(`${p.percent}%`),
    response: (res) => console.log(`Finished: ${res}`),
    error: (err) => console.error(err)
  });
});
```

## Router Composition & Merging

Waycast cleanly separates your **Schemas** (`Router`) from your **Implementation** (`ServerApp`). This allows you to split large applications into domain-driven modules seamlessly while preserving 100% type inference.

To split schemas, use the `.merge()` method:

```typescript
// users.ts
export const userRouter = new Router<Meta>()
  .data("user:status", t.String())
  .rpc("user:create", { /* ... */ });

// posts.ts
export const postRouter = new Router<Meta>()
  .rpc("post:like", { /* ... */ });

// index.ts
export const appRouter = new Router<Meta>()
  .merge(userRouter)
  .merge(postRouter);

export type AppRouter = typeof appRouter;
```

To split your implementations, simply define your `Server` type once and pass it to your controller modules:

```typescript
// router.ts
export type AppServer = ReturnType<typeof appRouter.buildServer<Context>>;

// controllers/user.ts
import type { AppServer } from "../router";

export function registerUserHandlers(server: AppServer) {
  // Autocomplete instantly knows about "user:create" and its payload!
  server.on("user:create", async (ctx) => {
    console.log("Creating user...", ctx.payload);
  });
}

// server.ts
const server = appRouter.buildServer<Context>(adapters);
registerUserHandlers(server);
```

## Utility Types (Custom Hooks)

Waycast exports powerful generic utilities designed specifically to help you build your own strictly-typed framework wrappers (like React/Vue hooks). By extracting types directly from your `AppRouter`, your UI hooks get the exact same aggressive type-safety as the core library!

```typescript
import type { Static } from "typebox";
import type { InferDataRoutes, InferRpcRoutes, ParamsOf } from "waycast";
import { appRouter, type AppRouter } from "./router";

type RpcRoutes = InferRpcRoutes<AppRouter>;
type DataRoutes = InferDataRoutes<AppRouter>;

// Build a custom strictly-typed React Hook!
export function useWaycastData<T extends Extract<keyof DataRoutes, string>>(
  topic: T,
  params: ParamsOf<T>
): Static<DataRoutes[T]> | undefined {
  const [data, setData] = useState<Static<DataRoutes[T]>>();

  useEffect(() => {
    // Automatically subscribes on mount, and unsubscribes on unmount!
    return client.onData(topic, params, (newData) => {
      setData(newData);
    });
  }, [topic, params]); // Ensure `params` is memoized or stable to avoid re-subscriptions

  return data;
}

// In your component:
// Fully typed! `params` forces { jobId: string }, and `data` is strongly inferred!
const data = useWaycastData("job:[jobId]:process", { jobId: "123" });
```

## License

MIT
