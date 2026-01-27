/**
 * Type declarations for Parse Cloud Code environment
 * Parse is injected as a global variable by Parse Server at runtime
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Declare parse-server module
declare module "parse-server" {
	export interface ParseServerOptions {
		databaseURI?: string;
		appId: string;
		masterKey: string;
		serverURL: string;
		clientKey?: string;
		cloud?: string;
		filesAdapter?: any;
		auth?: any;
		emailAdapter?: any;
		verifyUserEmails?: boolean;
		emailVerifyTokenValidityDuration?: number;
		preventLoginWithUnverifiedEmail?: boolean;
		allowClientClassCreation?: boolean;
		enableAnonymousUsers?: boolean;
		sessionLength?: number;
		enforcePrivateUsers?: boolean;
		[key: string]: any;
	}

	export class ParseServer {
		constructor(options: ParseServerOptions);
		app: any;
	}

	export default ParseServer;
}

// Declare parse/node module
declare module "parse/node" {
	export = Parse;
}

// Declare Parse as a global namespace
declare global {
	namespace Parse {
		// Options interfaces
		interface SaveOptions {
			useMasterKey?: boolean;
			sessionToken?: string;
			context?: any;
		}

		interface DestroyOptions {
			useMasterKey?: boolean;
			sessionToken?: string;
		}

		interface FetchOptions {
			useMasterKey?: boolean;
			sessionToken?: string;
		}

		interface QueryOptions {
			useMasterKey?: boolean;
			sessionToken?: string;
		}

		interface SignUpOptions {
			useMasterKey?: boolean;
		}

		interface LogInOptions {
			useMasterKey?: boolean;
		}

		// Base attributes interface
		interface Attributes {
			[key: string]: any;
		}

		// Parse.Object class
		class Object<T extends Attributes = Attributes> {
			id: string;
			createdAt?: Date;
			updatedAt?: Date;
			className: string;

			constructor(className: string, attributes?: T);

			get<K extends keyof T>(attr: K): T[K];
			get(attr: string): any;
			set<K extends keyof T>(attr: K, value: T[K]): this;
			set(attr: string, value: any): this;
			unset(attr: string): this;
			increment(attr: string, amount?: number): this;
			save(attrs?: any, options?: SaveOptions): Promise<this>;
			destroy(options?: DestroyOptions): Promise<this>;
			fetch(options?: FetchOptions): Promise<this>;
			toJSON(): T & {
				objectId: string;
				createdAt?: string;
				updatedAt?: string;
			};
			existed(): boolean;
			setACL(acl: ACL): this;
			getACL(): ACL | undefined;
		}

		namespace Object {
			function extend(
				className: string,
				protoProps?: any,
				classProps?: any,
			): any;
			function createWithoutData(id: string): Object;
			function destroyAll(
				objects: Object[],
				options?: DestroyOptions,
			): Promise<Object[]>;
			function saveAll(
				objects: Object[],
				options?: SaveOptions,
			): Promise<Object[]>;
		}

		// Parse.User class
		class User extends Object {
			id: string;

			static current(): User | undefined;
			static createWithoutData(id: string): User;
			static logIn(
				username: string,
				password: string,
				options?: LogInOptions,
			): Promise<User>;
			static logOut(): Promise<void>;

			getUsername(): string | undefined;
			setUsername(username: string): this;
			getEmail(): string | undefined;
			setEmail(email: string): this;
			signUp(attrs?: any, options?: SignUpOptions): Promise<this>;
			logIn(options?: LogInOptions): Promise<this>;
		}

		// Parse.Query class
		class Query<T = Object> {
			constructor(objectClass: string | typeof Object | typeof User);

			get(objectId: string, options?: QueryOptions): Promise<T>;
			find(options?: QueryOptions): Promise<T[]>;
			first(options?: QueryOptions): Promise<T | undefined>;
			count(options?: QueryOptions): Promise<number>;

			equalTo(key: string, value: any): this;
			notEqualTo(key: string, value: any): this;
			greaterThan(key: string, value: any): this;
			greaterThanOrEqualTo(key: string, value: any): this;
			lessThan(key: string, value: any): this;
			lessThanOrEqualTo(key: string, value: any): this;
			containedIn(key: string, values: any[]): this;
			notContainedIn(key: string, values: any[]): this;
			exists(key: string): this;
			doesNotExist(key: string): this;
			matches(key: string, regex: RegExp): this;
			matchesQuery(key: string, query: Query): this;
			include(key: string | string[]): this;
			select(...keys: string[]): this;
			limit(n: number): this;
			skip(n: number): this;
			ascending(key: string): this;
			addAscending(key: string): this;
			descending(key: string): this;
			addDescending(key: string): this;
			withinKilometers(key: string, point: GeoPoint, distance: number): this;
			withinMiles(key: string, point: GeoPoint, distance: number): this;
			near(key: string, point: GeoPoint): this;
		}

		// Parse.ACL class
		class ACL {
			constructor(user?: User);
			setPublicReadAccess(allowed: boolean): void;
			setPublicWriteAccess(allowed: boolean): void;
			setReadAccess(userId: string | User, allowed: boolean): void;
			setWriteAccess(userId: string | User, allowed: boolean): void;
			getPublicReadAccess(): boolean;
			getPublicWriteAccess(): boolean;
			getReadAccess(userId: string | User): boolean;
			getWriteAccess(userId: string | User): boolean;
		}

		// Parse.GeoPoint class
		class GeoPoint {
			latitude: number;
			longitude: number;
			constructor(latitude: number, longitude: number);
		}

		// Parse.File class
		class File {
			constructor(name: string, data?: any, type?: string);
			name(): string;
			url(): string;
			save(options?: SaveOptions): Promise<File>;
		}

		// Parse.Error class
		class Error {
			static INVALID_SESSION_TOKEN: number;
			static INVALID_VALUE: number;
			static OBJECT_NOT_FOUND: number;
			static OPERATION_FORBIDDEN: number;
			static DUPLICATE_VALUE: number;
			static INTERNAL_SERVER_ERROR: number;

			code: number;
			message: string;

			constructor(code: number, message: string);
		}

		// Parse.Schema class
		class Schema {
			constructor(className: string);
			get(): Promise<any>;
			save(): Promise<this>;
			update(): Promise<this>;
			delete(): Promise<void>;
			addField(name: string, type: any): this;
			addIndex(name: string, index: any): this;
			setCLP(clp: any): this;
		}

		// Parse.Cloud namespace
		namespace Cloud {
			interface FunctionRequest<T = any> {
				params: T;
				user?: User;
				master: boolean;
				installationId?: string;
				headers?: Record<string, string>;
				ip?: string;
			}

			interface TriggerRequest {
				object: Object;
				original?: Object;
				user?: User;
				master: boolean;
				installationId?: string;
				headers?: Record<string, string>;
				ip?: string;
			}

			interface JobRequest {
				params: any;
				message: (message: string) => void;
			}

			function define<T = any>(
				name: string,
				handler: (request: FunctionRequest<T>) => Promise<any> | any,
			): void;

			function beforeSave(
				className: string | typeof Object,
				handler: (request: TriggerRequest) => Promise<void> | void,
			): void;

			function afterSave(
				className: string | typeof Object,
				handler: (request: TriggerRequest) => Promise<void> | void,
			): void;

			function beforeDelete(
				className: string | typeof Object,
				handler: (request: TriggerRequest) => Promise<void> | void,
			): void;

			function afterDelete(
				className: string | typeof Object,
				handler: (request: TriggerRequest) => Promise<void> | void,
			): void;

			function job(
				name: string,
				handler: (request: JobRequest) => Promise<any> | any,
			): void;
		}
	}

	// Make Parse available as a global variable
	const Parse: typeof Parse;
}

export {};
