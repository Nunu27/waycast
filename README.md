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

export const appRouter = new Router<Context, Meta>()
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

```typescript
import { Server } from "socket.io";
import { appRouter, type AppRouter } from "./router";
import type { RequestMessage, DataMessage, RpcReplyMessage, InferDataRoutes, InferRpcRoutes, BuiltInRpcRoutes } from "waycast";

// 1. Setup strict Typing for Socket.io
type MyDataRoutes = InferDataRoutes<AppRouter>;
type MyRpcRoutes = InferRpcRoutes<AppRouter> & BuiltInRpcRoutes;

const io = new Server<{
  rpc: (message: RequestMessage<MyRpcRoutes>, ack: (requestId: string) => void) => void;
}, {
  data: (message: DataMessage<MyDataRoutes>) => void;
  reply: (message: RpcReplyMessage<MyRpcRoutes>) => void;
}>(3000);

// 2. Build the Waycast Server Adapter
const server = appRouter.buildServer({
  topic: {
    subscribe: (connId, ...topics) => io.sockets.sockets.get(connId)?.join(topics),
    unsubscribe: (connId, ...topics) => topics.forEach(t => io.sockets.sockets.get(connId)?.leave(t))
  },
  emit: (topic, message) => io.to(topic).emit("data", message),
  reply: (topic, message) => io.to(topic).emit("reply", message)
});

// 3. Register RPC Handlers
server.on("job:[jobId]:process", async (ctx) => {
  const { jobId } = ctx.params; // Fully Typed! { jobId: string }
  const { force } = ctx.payload; // Fully Typed! { force: boolean }

  // Send progressive intermediate replies
  ctx.reply("log", `Starting job ${jobId}`);
  ctx.reply("progress", { percent: 50 });

  return true; // Final response automatically sent
})
.on("metrics:ping", async (ctx) => {
  // Fire-and-forget: No response is sent over the network
  return undefined; 
})
.onDispose("job:[jobId]:process", (requestId) => {
  console.log(`Clean up request ${requestId} resources!`);
});

// Optional: Disconnected/Manual Replies outside the handler!
// server.reply("job:[jobId]:process", "req-123", "progress", { percent: 100 });
// server.replyResponse("job:[jobId]:process", "req-123", true);

// 4. Clean up lingering RPCs when sockets leave rooms (or disconnect)
io.of("/").adapter.on("leave-room", (room, id) => {
  // Waycast intelligently delimits with | to avoid namespace collisions
  if (room.endsWith("|reply")) server.handleDispose(room);
});

// 5. Hook up the Socket
io.on("connection", (socket) => {
  socket.on("rpc", (message, ack) => {
    const requestId = Math.random().toString(36).slice(2); // Server generates ID
    if (ack) ack(requestId); // Send ACK back to client

    // Pass the message into Waycast
    server.handle(socket.id, requestId, message, async (meta) => {
      // Incoming payload is instantly validated against your TypeBox schema!
      return { userId: "user-123" }; // Injects context
    });
  });
});
```

### 3. Setup the Client

```typescript
import { io, Socket } from "socket.io-client";
import { appRouter, type AppRouter } from "./router";

const socket = io("http://localhost:3000");

// 1. Build the Waycast Client Adapter
const client = appRouter.buildClient({
  send: (message) => {
    return new Promise((resolve) => {
      socket.emit("rpc", message, (requestId) => {
        resolve(requestId); // Resolve the Promise when Server ACKs
      });
    });
  }
});

// 2. Hook up incoming Socket messages
socket.on("data", (msg) => client.handleData(msg));
socket.on("reply", (msg) => client.handleReply(msg));

socket.on("connect", () => {
  // 3. Automatically Subscribe to Data Streams
  // Listens dynamically based on the topic string rather than tracking raw JSON blobs.
  // Waycast intelligently fires _waycast:subscribe on your behalf!
  client.onData("system:alerts", undefined, (msg) => {
    console.log(`Alert: ${msg}`); // Strongly typed to string
  });

  // 4. Call an RPC
  client.rpc("job:[jobId]:process", { jobId: "backup" }, { force: true }, {
    log: (msg) => console.log(msg),
    progress: (p) => console.log(`${p.percent}%`),
    response: (res) => console.log(`Finished: ${res}`),
    error: (err) => console.error(err)
  });
});
```

## License

MIT
