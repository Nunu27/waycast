import type { TArray, TObject, TSchema, TString, TVoid } from "typebox";
import { Type } from "typebox";
import { ClientApp } from "./client";
import { ServerApp } from "./server";
import type { ClientAdapters, RpcDef, ServerAdapters } from "./types";

export type BuiltInRpcRoutes = {
	"_waycast:subscribe": RpcDef<
		TObject<{ topics: TArray<TString> }>,
		{},
		TVoid,
		any
	>;
	"_waycast:unsubscribe": RpcDef<
		TObject<{ topics: TArray<TString> }>,
		{},
		TVoid,
		any
	>;
};

export class Router<
	Meta,
	DataRoutes extends Record<string, TSchema> = {},
	RpcRoutes extends Record<string, RpcDef<any, any, any, Meta>> = {},
> {
	public _dataRoutes: Record<string, any> = {};
	public _rpcRoutes: Record<string, any> = {
		"_waycast:subscribe": {
			payload: Type.Object({ topics: Type.Array(Type.String()) }),
			replies: {},
			response: Type.Void(),
			meta: {},
		},
		"_waycast:unsubscribe": {
			payload: Type.Object({ topics: Type.Array(Type.String()) }),
			replies: {},
			response: Type.Void(),
			meta: {},
		},
	};

	data<Name extends string, Schema extends TSchema>(
		name: Name,
		schema: Schema,
	): Router<Meta, DataRoutes & { [K in Name]: Schema }, RpcRoutes> {
		this._dataRoutes[name] = schema;
		return this as any;
	}

	rpc<
		Name extends string,
		Payload extends TSchema,
		Replies extends Record<string, TSchema>,
		Response extends TSchema,
	>(
		name: Name,
		def: { payload: Payload; replies: Replies; response: Response; meta: Meta },
	): Router<
		Meta,
		DataRoutes,
		RpcRoutes & { [K in Name]: RpcDef<Payload, Replies, Response, Meta> }
	> {
		this._rpcRoutes[name] = def;
		return this as any;
	}

	merge<
		OtherData extends Record<string, TSchema>,
		OtherRpc extends Record<string, RpcDef<any, any, any, Meta>>,
	>(
		other: Router<Meta, OtherData, OtherRpc>,
	): Router<Meta, DataRoutes & OtherData, RpcRoutes & OtherRpc> {
		this._dataRoutes = { ...this._dataRoutes, ...other._dataRoutes };
		this._rpcRoutes = { ...this._rpcRoutes, ...other._rpcRoutes };
		return this as any;
	}

	_getRpcRoute(name: string): any {
		return this._rpcRoutes[name];
	}

	buildServer<Context = {}>(
		adapters: ServerAdapters<DataRoutes, RpcRoutes & BuiltInRpcRoutes>,
	): ServerApp<Context, Meta, DataRoutes, RpcRoutes> {
		return new ServerApp(this as any, adapters);
	}

	buildClient(
		adapters: ClientAdapters<RpcRoutes & BuiltInRpcRoutes>,
	): ClientApp<DataRoutes, RpcRoutes> {
		return new ClientApp(this as any, adapters);
	}
}

export type InferDataRoutes<T> =
	T extends Router<any, infer D, any> ? D : never;
export type InferRpcRoutes<T> = T extends Router<any, any, infer R> ? R : never;

export const buildDataTopic = (
	name: string,
	params?: Record<string, string>,
) => {
	if (!params) return name;
	let topic = name;
	for (const [key, value] of Object.entries(params)) {
		topic = topic.replace(`[${key}]`, value);
	}
	return topic;
};

export const buildReplyTopic = (name: string, requestId: string) =>
	`${name}|${requestId}|reply`;
