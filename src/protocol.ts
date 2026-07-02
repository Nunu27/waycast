import type { RouteDef } from "./router.ts";

export type ClientMessage =
	| { type: "handshake"; fingerprint: string }
	| { type: "subscribe"; topics: string[] }
	| { type: "unsubscribe"; topics: string[] }
	| {
			type: "rpc";
			name: string;
			requestId: string;
			params: Record<string, string>;
			payload?: unknown;
	  };

export type ServerMessage =
	| { type: "handshake"; ok: boolean }
	| { type: "publish"; topic: string; payload: unknown }
	| { type: "subscribe-rejected"; topic: string; reason: string };

export interface ReplyEnvelope {
	key: string;
	value: unknown;
}

// Deterministic, dependency-free FNV-1a hash over the route manifest's shape — names,
// params, which of payload/response/replies are present, reply key names. Deliberately
// does NOT hash the schemas themselves (opaque validator functions, not comparable).
export function computeRouterFingerprint(
	routes: ReadonlyMap<string, RouteDef>,
): string {
	const manifest = [...routes.keys()]
		.sort()
		.map((name) => describeRoute(name, routes.get(name) as RouteDef))
		.join("\n");

	let hash = 0x811c9dc5;
	for (let i = 0; i < manifest.length; i++) {
		hash ^= manifest.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

function describeRoute(name: string, def: RouteDef): string {
	if (def.kind === "rpc") {
		const replyKeys = Object.keys(def.replies).sort().join(",");
		return `rpc:${name}:payload=${Boolean(def.payload)}:response=${Boolean(def.response)}:replies=${replyKeys}`;
	}
	return `data:${name}:schema=${Boolean(def.schema)}`;
}

export function replyTopic(name: string, requestId: string): string {
	return `${name}|${requestId}|reply`;
}

export function isReplyTopic(topic: string): boolean {
	return topic.endsWith("|reply");
}

// Cross-instance control channel: when one instance rejects a resubscribe to a reply topic
// it doesn't own, it broadcasts this so whichever instance actually owns the request can
// dispose immediately instead of waiting out the disconnect grace period. Contains "|"
// outside the fixed "|reply" suffix, which route names can never contain (see
// Waycast.assertValidName) and param values can't produce (percent-encoded by
// buildRouteName) — guarantees this can never collide with a real route/reply topic.
export const ABANDON_TOPIC = "__waycast:abandon__|control";

export interface AbandonMessage {
	topic: string;
}
