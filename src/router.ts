import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type BuildClientOptions,
	buildClient as buildClientImpl,
	type WaycastClient,
} from "./client.ts";
import {
	type CompiledRoute,
	compileRoute,
	matchRoute,
	type RouteParams,
} from "./route-name.ts";
import {
	type BuildServerOptions,
	buildServer as buildServerImpl,
	type WaycastServer,
} from "./server.ts";

// biome-ignore lint/suspicious/noExplicitAny: intentional — library type-erasure for schema variance
export type AnySchema = StandardSchemaV1<any, any>;
// biome-ignore lint/complexity/noBannedTypes: empty object is a valid type
type EmptyObject = {};

export type InferOutput<S extends AnySchema | undefined> = S extends AnySchema
	? StandardSchemaV1.InferOutput<S>
	: undefined;

export interface RpcRouteDef {
	kind: "rpc";
	name: string;
	payload?: AnySchema;
	response?: AnySchema;
	replies: Record<string, AnySchema>;
	meta?: unknown;
}

export interface DataRouteDef {
	kind: "data";
	name: string;
	schema?: AnySchema;
	meta?: unknown;
}

export type RouteDef = RpcRouteDef | DataRouteDef;
export type RouteMap = Record<string, RouteDef>;

export interface RpcRoute<
	Name extends string = string,
	Payload extends AnySchema | undefined = AnySchema | undefined,
	Response extends AnySchema | undefined = AnySchema | undefined,
	Replies extends Record<string, AnySchema> = Record<string, AnySchema>,
	RouteMeta = unknown,
> {
	kind: "rpc";
	name: Name;
	payload: Payload;
	response: Response;
	replies: Replies;
	meta: RouteMeta;
}

export interface DataRoute<
	Name extends string = string,
	Schema extends AnySchema | undefined = AnySchema | undefined,
	RouteMeta = unknown,
> {
	kind: "data";
	name: Name;
	schema: Schema;
	meta: RouteMeta;
}

export type AnyRoute = RpcRoute | DataRoute;

interface RpcConfig<
	Payload extends AnySchema | undefined,
	Response extends AnySchema | undefined,
	Replies extends Record<string, AnySchema>,
	Meta,
> {
	payload?: Payload;
	response?: Response;
	replies?: Replies;
	meta?: Meta;
}

export interface WaycastOptions {
	maxDisconnectionDuration?: number;
}

export class Waycast<
	Meta = undefined,
	Routes extends Record<string, AnyRoute> = EmptyObject,
> {
	readonly _routes = new Map<string, RouteDef>();
	readonly options: Required<WaycastOptions>;

	constructor(options: WaycastOptions = {}) {
		this.options = {
			maxDisconnectionDuration: options.maxDisconnectionDuration ?? 5000,
		};
	}

	private assertValidName(name: string) {
		if (name.includes("|"))
			throw new Error(
				`Route name "${name}" must not contain "|" (reserved for internal reply topics)`,
			);
		if (this._routes.has(name))
			throw new Error(`Route "${name}" is already registered`);
	}

	rpc<
		Name extends string,
		Payload extends AnySchema | undefined = undefined,
		Response extends AnySchema | undefined = undefined,
		Replies extends Record<string, AnySchema> = Record<string, never>,
	>(
		name: Name,
		config: RpcConfig<Payload, Response, Replies, Meta> = {},
	): Waycast<
		Meta,
		Routes & Record<Name, RpcRoute<Name, Payload, Response, Replies, Meta>>
	> {
		this.assertValidName(name);
		this._routes.set(name, {
			kind: "rpc",
			name,
			payload: config.payload as AnySchema | undefined,
			response: config.response as AnySchema | undefined,
			replies: (config.replies ?? {}) as Record<string, AnySchema>,
			meta: config.meta,
		});
		return this as unknown as Waycast<
			Meta,
			Routes & Record<Name, RpcRoute<Name, Payload, Response, Replies, Meta>>
		>;
	}

	data<Name extends string, Schema extends AnySchema | undefined = undefined>(
		name: Name,
		schema?: Schema,
		meta?: Meta,
	): Waycast<Meta, Routes & Record<Name, DataRoute<Name, Schema, Meta>>> {
		this.assertValidName(name);
		this._routes.set(name, {
			kind: "data",
			name,
			schema: schema as AnySchema | undefined,
			meta,
		});
		return this as unknown as Waycast<
			Meta,
			Routes & Record<Name, DataRoute<Name, Schema, Meta>>
		>;
	}

	merge<OtherRoutes extends Record<string, AnyRoute>>(
		other: Waycast<Meta, OtherRoutes>,
	): Waycast<Meta, Routes & OtherRoutes> {
		for (const [name, def] of other._routes) {
			if (this._routes.has(name))
				throw new Error(
					`Route "${name}" already exists — cannot merge conflicting route names`,
				);
			this._routes.set(name, def);
		}
		return this as unknown as Waycast<Meta, Routes & OtherRoutes>;
	}

	buildServer<Context = undefined>(
		options: BuildServerOptions<Context, Meta>,
	): WaycastServer<Context, Routes> {
		return buildServerImpl(this, options);
	}

	buildClient(options: BuildClientOptions): WaycastClient<Routes> {
		return buildClientImpl(this, options);
	}
}

export default Waycast;

export type { RouteParams };

export interface ResolvedRoute {
	def: RouteDef;
	params: Record<string, string>;
}

// Resolves a concrete wire name (e.g. "test:rpc:42") against the registered routes,
// extracting params along the way. Exact (param-less) routes are checked first via a
// plain map lookup, parametrized routes fall back to regex matching in registration order.
export class RouteRegistry {
	private readonly exact = new Map<string, RouteDef>();
	private readonly parametrized: { def: RouteDef; compiled: CompiledRoute }[] =
		[];

	constructor(routes: Map<string, RouteDef>) {
		for (const def of routes.values()) {
			const compiled = compileRoute(def.name);
			if (compiled.paramNames.length === 0) {
				this.exact.set(def.name, def);
			} else {
				this.parametrized.push({ def, compiled });
			}
		}
	}

	resolve(name: string): ResolvedRoute | undefined {
		const exact = this.exact.get(name);
		if (exact) return { def: exact, params: {} };

		for (const { def, compiled } of this.parametrized) {
			const params = matchRoute(compiled, name);
			if (params) return { def, params };
		}

		return undefined;
	}
}
