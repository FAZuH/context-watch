import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";
import pluginFactory from "../src/index";

const ENV_VARS = [
	"CONTEXT_WATCH_PERCENT",
	"CONTEXT_WATCH_TOKENS",
	"CONTEXT_WATCH_WINDOW",
	"CONTEXT_WATCH_REARM",
	"CONTEXT_WATCH_REARM_TOKENS",
	"CONTEXT_WATCH_MESSAGE",
	"CONTEXT_WATCH_NO_TOAST",
];

export interface FakeClient {
	tui: {
		showToast: (arg: {
			body: { message: string; variant: string };
		}) => Promise<unknown>;
	};
	app: {
		log: (arg: {
			body: { level: string; message: string; extra: unknown };
		}) => Promise<unknown>;
	};
}

export interface Harness {
	toasts: { message: string; variant: string }[];
	appLogs: { level: string; message: string; extra: unknown }[];
	showToastCalls: () => number;
	handlers: Awaited<ReturnType<Plugin>>;
	cleanup: () => void;
}

export function must<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`${what} missing`);
	return value;
}

/**
 * Boot a fresh plugin instance with a fake client and an isolated config file
 * path (passed via the plugin's test-only `configPath` seam), so the real
 * config-reading path is exercised without touching the user's HOME.
 */
export async function createHarness(
	config: string | null,
	opts: { failFirstToast?: boolean; env?: Record<string, string> } = {},
): Promise<Harness> {
	const home = mkdtempSync(join(tmpdir(), "context-watch-test-"));
	const configPath = join(home, "context-watch.json");
	if (config !== null) {
		writeFileSync(configPath, config, "utf8");
	}

	const savedEnv = new Map<string, string | undefined>();
	for (const v of ENV_VARS) {
		savedEnv.set(v, process.env[v]);
		delete process.env[v];
	}
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		process.env[k] = v;
	}

	let showToastCalls = 0;
	const toasts: { message: string; variant: string }[] = [];
	const appLogs: { level: string; message: string; extra: unknown }[] = [];
	const client: FakeClient = {
		tui: {
			showToast: async ({ body }) => {
				showToastCalls++;
				if (opts.failFirstToast && showToastCalls === 1)
					throw new Error("no TUI yet");
				toasts.push(body);
				return {};
			},
		},
		app: {
			log: async ({ body }) => {
				appLogs.push(body);
				return {};
			},
		},
	};

	const handlers = await pluginFactory({ client } as never, { configPath });
	await new Promise((r) => setTimeout(r, 0));

	return {
		toasts,
		appLogs,
		showToastCalls: () => showToastCalls,
		handlers,
		cleanup: () => {
			rmSync(home, { recursive: true, force: true });
			for (const v of ENV_VARS) {
				const prev = savedEnv.get(v);
				if (prev === undefined) delete process.env[v];
				else process.env[v] = prev;
			}
		},
	};
}

export interface AssistantTokens {
	input: number;
	output: number;
	reasoning?: number;
	cache?: { read: number; write: number };
}

/**
 * Build the `output.messages` shape the messages.transform hook receives:
 * a user message followed by the most recent completed assistant message
 * carrying the provider-reported token counts that drive the context meter.
 */
export function buildMessages(
	tokens: AssistantTokens,
	sessionID = "session-test",
) {
	const info = (id: string, role: "user" | "assistant"): Message =>
		({
			id,
			sessionID,
			role,
			time: { created: 1_700_000_000_000 },
			agent: "build",
			model: { providerID: "opencode", modelID: "test" },
			...(role === "assistant" ? { tokens } : {}),
		}) as Message;
	const part = (id: string, role: "user" | "assistant"): Part =>
		({
			id: `part_${id}`,
			sessionID,
			messageID: id,
			type: "text",
			text: role === "user" ? "user message" : "assistant reply",
			synthetic: false,
		}) as Part;
	const user = info("msg_user_1", "user");
	const assistant = info("msg_assistant_1", "assistant");
	return {
		messages: [
			{ info: user, parts: [part(user.id, "user")] },
			{ info: assistant, parts: [part(assistant.id, "assistant")] },
		],
	};
}
