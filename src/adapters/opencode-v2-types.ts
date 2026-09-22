// Minimal structural types for the OpenCode v2 plugin API, transcribed from @opencode/plugin@2.0.12 (dist/promise/*.d.ts) and @opencode/schema@2.0.12. Kept local to avoid a 263-package dev dependency closure for a type-only import. Revisit if upstream publishes a lightweight types package.

export interface Registration {
  readonly dispose: () => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Location {
  export interface Info {
    readonly directory: string;
    readonly project: {
      readonly id?: string;
      readonly directory: string;
      readonly canonical?: string;
    };
    readonly workspaceID?: string;
    readonly [key: string]: unknown;
  }
}

export type ToolMetadata = Readonly<Record<string, unknown>>;

export interface ToolContext {
  readonly sessionID?: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly signal?: AbortSignal;
  readonly progress?: (update: ToolMetadata) => Promise<void> | void;
  readonly [key: string]: unknown;
}

export interface ToolResult<Output = unknown> {
  readonly output?: Output;
  readonly content?: string | ReadonlyArray<unknown>;
  readonly metadata?: ToolMetadata;
  readonly [key: string]: unknown;
}

export interface ToolInfo<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly execute: (input: unknown, context: ToolContext) => Promise<ToolResult<Output>> | ToolResult<Output>;
  readonly output?: Output;
  readonly options?: unknown;
  readonly [key: string]: unknown;
}

export interface ToolEditor {
  add<Input = unknown, Output = unknown>(tool: ToolInfo<Input, Output>): void;
  list?(): readonly unknown[];
  get?(id: string): unknown;
  namespace?(namespace: unknown): void;
  update?(id: string, update: (tool: unknown) => void): void;
  remove?(id: string): void;
  readonly [key: string]: unknown;
}

export interface ToolExecuteAfterEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID?: string;
  readonly id?: string;
  readonly input?: unknown;
  readonly status?: "completed" | "error" | string;
  result?: ToolResult;
  error?: unknown;
  readonly [key: string]: unknown;
}

export interface ToolHooks {
  readonly "execute.before"?: unknown;
  readonly "execute.after": ToolExecuteAfterEvent;
  readonly [key: string]: unknown;
}

export interface ToolDomain {
  readonly transform: (callback: (editor: ToolEditor) => void) => Promise<Registration>;
  readonly hook: <Name extends string>(
    name: Name,
    callback: (event: Name extends keyof ToolHooks ? ToolHooks[Name] : any) => Promise<void> | void
  ) => Promise<Registration>;
  readonly reload?: () => Promise<void>;
  readonly list?: () => Promise<readonly unknown[]>;
  readonly [key: string]: unknown;
}

export interface SessionPromptEvent {
  readonly sessionID: string;
  readonly messageID?: string;
  prompt: {
    text?: string;
    files?: readonly unknown[];
    agents?: readonly unknown[];
    skills?: readonly unknown[];
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
  delivery?: unknown;
  readonly [key: string]: unknown;
}

export interface SystemTextPart {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export type SystemPart = SystemTextPart | { type: string; [key: string]: unknown };

export interface SessionContextEvent {
  readonly sessionID: string;
  system: Array<SystemPart>;
  messages?: Array<unknown>;
  tools?: Record<string, unknown>;
  options?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface SessionHooks {
  readonly prompt: SessionPromptEvent;
  readonly context: SessionContextEvent;
  readonly [key: string]: unknown;
}

export interface SessionPromptOptions {
  sessionID?: string;
  text: string;
  files?: readonly unknown[];
  agents?: readonly unknown[];
  skills?: readonly unknown[];
  delivery?: unknown;
  [key: string]: unknown;
}

export interface SessionDomain {
  readonly hook: <Name extends string>(
    name: Name,
    callback: (event: Name extends keyof SessionHooks ? SessionHooks[Name] : any) => Promise<void> | void,
    options?: unknown
  ) => Promise<Registration>;
  readonly prompt: (options: SessionPromptOptions) => Promise<unknown>;
  readonly [key: string]: unknown;
}

export interface CommandInvocation {
  readonly sessionID: string;
  readonly prompt: {
    text: string;
    files?: readonly { mention?: unknown; [key: string]: unknown }[];
    agents?: readonly { mention?: unknown; [key: string]: unknown }[];
    skills?: readonly { mention?: unknown; [key: string]: unknown }[];
    [key: string]: unknown;
  };
  readonly delivery?: unknown;
  readonly [key: string]: unknown;
}

export interface CommandDefinition {
  readonly name: string;
  readonly description?: string;
  readonly execute: (input: CommandInvocation) => Promise<void>;
  readonly [key: string]: unknown;
}

export interface CommandEditor {
  add(definition: CommandDefinition): void;
  readonly [key: string]: unknown;
}

export interface CommandDomain {
  readonly transform: (callback: (editor: CommandEditor) => void) => Promise<Registration>;
  readonly reload?: () => Promise<void>;
  readonly [key: string]: unknown;
}

export interface Context {
  readonly location: Location.Info;
  readonly tool: ToolDomain;
  readonly session: SessionDomain;
  readonly command: CommandDomain;
  readonly options?: Record<string, unknown>;
  readonly storage?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export type Cleanup = () => Promise<void> | void;

export interface Plugin {
  readonly id: string;
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
  readonly [key: string]: unknown;
}
