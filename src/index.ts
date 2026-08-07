import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";
import type { Message, Part } from "@opencode-ai/sdk";

interface ContextWatchOptions {
	warnPercent?: number;
	warnTokens?: number;
	windowTokens?: number | null;
	rearmPercent?: number;
	rearmTokens?: number;
	toast?: boolean;
	verbose?: boolean;
	message?: string;
	postCompactContinue?: boolean;
	postCompactMsg?: string;
}

interface ConfigProblem {
	key: string;
	message: string;
}

export type { ConfigProblem };

/**
 * Minimal structural shape of the v2 SDK client we need for compaction. The
 * real `@opencode-ai/sdk/v2` client satisfies it (`v2.session.compact`); the
 * plugin also accepts a fake via the test seam, and loads the real one lazily
 * so a missing v2 export degrades to the v1 fallback instead of crashing
 * plugin load.
 */
export interface V2CompactClient {
	v2: {
		session: {
			compact(params: { sessionID: string }): Promise<unknown>;
		};
	};
}

const CONFIG_PATH = join(
	homedir(),
	".config/opencode/opencode-context-watch.json",
);

const DEFAULTS = {
	warnPercent: 0.77,
	warnTokens: 150_000,
	windowTokens: null as number | null,
	rearmPercent: 5,
	rearmTokens: 5_000,
	toast: true,
	verbose: false,
	message:
		"[context-watch] Context window usage is at {percent}% ({tokens}/{window} tokens). The session is getting full: wrap up the current step soon, keep replies concise, avoid re-reading large files, and be ready to prepare for compaction if you continue.",
	postCompactContinue: false,
	postCompactMsg:
		"[context-watch] Session context was compacted. Continue your work from where you left off, keeping replies concise.",
};

const CONFIG_KEYS = new Set([
	"warnPercent",
	"warnTokens",
	"windowTokens",
	"rearmPercent",
	"rearmTokens",
	"toast",
	"verbose",
	"message",
	"postCompactContinue",
	"postCompactMsg",
]);

// How long to wait for the v1 summarize before giving up on its response. See
// triggerCompact: awaiting it to completion deadlocks the session loop.
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 3000;

/**
 * Pure config resolution: given the parsed config file contents and an env
 * map, validate every option and fall back to the default for each bad value.
 * Returns the resolved options plus a list of problems describing what was
 * wrong. No filesystem, no `process.env` — both are injected by callers.
 */
export function resolveOptions(
	raw: unknown,
	env: Record<string, string | undefined>,
): { options: Required<ContextWatchOptions>; problems: ConfigProblem[] } {
	// opencode's bootstrap plugin-load pass may call this with `env === undefined`.
	const envMap = env ?? {};
	const problems: ConfigProblem[] = [];

	let conf: Record<string, unknown>;
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
		conf = raw as Record<string, unknown>;
	} else {
		problems.push({
			key: "file",
			message: "config root must be a JSON object",
		});
		conf = {};
	}

	for (const key of Object.keys(conf)) {
		if (!CONFIG_KEYS.has(key)) {
			problems.push({ key, message: `unknown option "${key}" (ignored)` });
		}
	}

	const num = (
		envName: string,
		fileKey: string,
		fallback: number,
		expected: string,
		test: (n: number) => boolean,
	): number => {
		const envValue = envMap[envName];
		if (envValue !== undefined) {
			const n = Number(envValue);
			if (Number.isFinite(n) && test(n)) return n;
			problems.push({
				key: fileKey,
				message: `${envName} must be ${expected} (got ${JSON.stringify(envValue)}); falling back to config/default`,
			});
		}
		const value = conf[fileKey];
		if (value !== undefined) {
			const n = Number(value);
			if (Number.isFinite(n) && test(n)) return n;
			problems.push({
				key: fileKey,
				message: `${fileKey} must be ${expected} (got ${JSON.stringify(value)})`,
			});
		}
		return fallback;
	};

	const warnPercent = num(
		"CONTEXT_WATCH_PERCENT",
		"warnPercent",
		DEFAULTS.warnPercent,
		"a number greater than 0 and at most 100",
		(n) => n > 0 && n <= 100,
	);

	const warnTokens = num(
		"CONTEXT_WATCH_TOKENS",
		"warnTokens",
		DEFAULTS.warnTokens,
		"a positive number",
		(n) => n > 0,
	);

	const windowTokens = (() => {
		const envValue = envMap.CONTEXT_WATCH_WINDOW;
		if (envValue !== undefined) {
			const n = Number(envValue);
			if (Number.isFinite(n) && n > 0) return n;
			problems.push({
				key: "windowTokens",
				message: `CONTEXT_WATCH_WINDOW must be a positive number or null (got ${JSON.stringify(envValue)}); falling back to config/default`,
			});
		}
		const value = conf.windowTokens;
		if (value === null) return null;
		if (value !== undefined) {
			const n = Number(value);
			if (Number.isFinite(n) && n > 0) return n;
			problems.push({
				key: "windowTokens",
				message: `windowTokens must be a positive number or null (got ${JSON.stringify(value)})`,
			});
		}
		return DEFAULTS.windowTokens;
	})();

	const rearmPercent = num(
		"CONTEXT_WATCH_REARM",
		"rearmPercent",
		DEFAULTS.rearmPercent,
		"a positive number",
		(n) => n > 0,
	);

	const rearmTokens = num(
		"CONTEXT_WATCH_REARM_TOKENS",
		"rearmTokens",
		DEFAULTS.rearmTokens,
		"a positive number",
		(n) => n > 0,
	);

	const bool = (fileKey: string, fallback: boolean): boolean => {
		const value = conf[fileKey];
		if (value !== undefined) {
			if (typeof value === "boolean") return value;
			problems.push({
				key: fileKey,
				message: `${fileKey} must be a boolean (got ${JSON.stringify(value)})`,
			});
		}
		return fallback;
	};

	let message = DEFAULTS.message;
	if (envMap.CONTEXT_WATCH_MESSAGE !== undefined) {
		message = envMap.CONTEXT_WATCH_MESSAGE;
	} else {
		const value = conf.message;
		if (value !== undefined) {
			if (typeof value === "string" && value.trim().length > 0) {
				message = value;
			} else {
				problems.push({
					key: "message",
					message: `message must be a non-empty string (got ${JSON.stringify(value)})`,
				});
			}
		}
	}

	const postCompactContinue = (() => {
		const envValue = envMap.CONTEXT_WATCH_POST_COMPACT_CONTINUE;
		if (envValue !== undefined) {
			if (envValue === "true") return true;
			if (envValue === "false") return false;
			const n = Number(envValue);
			if (Number.isFinite(n)) return n !== 0;
			problems.push({
				key: "postCompactContinue",
				message: `CONTEXT_WATCH_POST_COMPACT_CONTINUE must be a boolean (got ${JSON.stringify(envValue)}); falling back to config/default`,
			});
		}
		return bool("postCompactContinue", DEFAULTS.postCompactContinue);
	})();

	let postCompactMsg = DEFAULTS.postCompactMsg;
	if (envMap.CONTEXT_WATCH_POST_COMPACT_MSG !== undefined) {
		postCompactMsg = envMap.CONTEXT_WATCH_POST_COMPACT_MSG;
	} else {
		const value = conf.postCompactMsg;
		if (value !== undefined) {
			if (typeof value === "string" && value.trim().length > 0) {
				postCompactMsg = value;
			} else {
				problems.push({
					key: "postCompactMsg",
					message: `postCompactMsg must be a non-empty string (got ${JSON.stringify(value)})`,
				});
			}
		}
	}

	return {
		options: {
			warnPercent: warnPercent > 1 ? warnPercent / 100 : warnPercent,
			warnTokens,
			windowTokens,
			rearmPercent,
			rearmTokens,
			toast: envMap.CONTEXT_WATCH_NO_TOAST
				? false
				: bool("toast", DEFAULTS.toast),
			verbose: bool("verbose", DEFAULTS.verbose),
			message,
			postCompactContinue,
			postCompactMsg,
		},
		problems,
	};
}

function loadOptions(configPath: string = CONFIG_PATH): {
	options: Required<ContextWatchOptions>;
	problems: ConfigProblem[];
} {
	const problems: ConfigProblem[] = [];
	let raw: unknown = {};
	try {
		if (existsSync(configPath)) {
			raw = JSON.parse(readFileSync(configPath, "utf8"));
		}
	} catch (err) {
		problems.push({
			key: "file",
			message: `${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
	const { options, problems: resolvedProblems } = resolveOptions(
		raw,
		process.env,
	);
	return { options, problems: [...problems, ...resolvedProblems] };
}

/**
 * Return the provider-reported context size, matching opencode's TUI context
 * meter: the most recent completed assistant message's
 * `input + output + reasoning + cache.read + cache.write`. This is the ground
 * truth for how full the window actually is.
 */
function contextTokens(
	messages: { info: Message; parts: Part[] }[],
): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const info = messages[i].info;
		if (info.role !== "assistant") continue;
		const t = info.tokens;
		if (!t || !t.input || t.input <= 0) continue;
		if (!t.output || t.output <= 0) continue;
		return (
			t.input +
			(t.output ?? 0) +
			(t.reasoning ?? 0) +
			(t.cache?.read ?? 0) +
			(t.cache?.write ?? 0)
		);
	}
	return undefined;
}

export const ContextWatchPlugin: Plugin = async (
	{ client, serverUrl },
	pluginOptions,
) => {
	// Test-only seams; opencode always uses the default config path and its own
	// bundled `@opencode-ai/sdk/v2` client factory.
	const seam = pluginOptions as
		| {
				configPath?: string;
				createOpencodeClientV2?: (config: {
					baseUrl?: string;
				}) => V2CompactClient;
				summarizeTimeoutMs?: number;
		  }
		| undefined;
	const configPath = seam?.configPath;
	const { options: opts, problems } = loadOptions(configPath);
	const thresholdPct = opts.warnPercent * 100;

	// Config-error toast: fire at load time; if the TUI is not connected yet it
	// fails (falling back to the opencode log) and we retry on the first message
	// transform. Capped attempts so a headless run cannot spam the log. The
	// shown/in-flight flags are set synchronously (never via a `.then` callback)
	// so the retry cannot race or double-fire, and configToast never rejects.
	let configErrorShown = false;
	let configErrorInFlight = false;
	let configToastAttempts = 0;
	const configToast = async (): Promise<void> => {
		if (configErrorShown || configErrorInFlight || configToastAttempts >= 3)
			return;
		configToastAttempts++;
		configErrorInFlight = true;
		const joined = problems.map((p) => p.message).join("; ");
		const text = `[context-watch] invalid config (${configPath}): ${joined}`;
		const capped = text.length > 400 ? `${text.slice(0, 397)}...` : text;
		try {
			await client.tui.showToast({
				body: { message: capped, variant: "error" },
			});
			configErrorShown = true;
		} catch (err) {
			console.log("[context-watch] invalid config", joined, err);
		} finally {
			configErrorInFlight = false;
		}
	};
	if (problems.length > 0) {
		console.log("[context-watch] invalid config", JSON.stringify(problems));
		client.app
			.log({
				body: {
					service: "context-watch",
					level: "error",
					message: "invalid config",
					extra: { problems },
				},
			})
			.catch(() => {});
		void configToast();
	}

	// sessionID -> model info, cached by system.transform (messages.transform has no model info)
	const modelCache = new Map<
		string,
		{ window?: number; providerID?: string; modelID?: string }
	>();
	// sessionID -> last warned value per band, to rearm only after a rise
	const lastWarned = new Map<string, { pct?: number; tokens?: number }>();

	// v2 client for the compact_context tool, built once at load. Loaded lazily
	// (client-only subpath — the full `/v2` entry pulls in the server and would
	// break the browser-mode bundle with node builtins) so a missing v2 export
	// degrades to the v1 fallback instead of crashing plugin load; tests inject
	// a fake via the seam.
	let v2Client: V2CompactClient | undefined;
	try {
		const create = seam?.createOpencodeClientV2;
		v2Client = create
			? create({ baseUrl: serverUrl?.href })
			: (await import("@opencode-ai/sdk/v2/client")).createOpencodeClient({
					baseUrl: serverUrl?.href,
				});
	} catch (err) {
		v2Client = undefined;
		console.log(
			"[context-watch] v2 compact client unavailable; using v1 fallback",
			err,
		);
	}

	const toast = async (text: string) => {
		if (!opts.toast) return;
		try {
			await client.tui.showToast({
				body: { message: text, variant: "warning" },
			});
		} catch (err) {
			console.log("[context-watch]", text);
		}
	};

	const log = (
		level: "debug" | "warn",
		message: string,
		extra: Record<string, unknown>,
	) => {
		if (!opts.verbose) return;
		console.log("[context-watch]", message, JSON.stringify(extra));
		client.app
			.log({ body: { service: "context-watch", level, message, extra } })
			.catch(() => {});
	};

	// The SDK clients RESOLVE (do not throw) even on error, carrying an `error`
	// field on the result (e.g. `{ error: {...}, response: {} }`). Treat any
	// such resolution as a failure so we fall through to the next path.
	const extractError = (res: unknown): string | undefined => {
		if (res && typeof res === "object" && "error" in res) {
			const e = (res as { error?: unknown }).error;
			if (!e) return undefined;
			if (typeof e === "string") return e;
			try {
				return JSON.stringify(e);
			} catch {
				return String(e);
			}
		}
		return undefined;
	};

	// Trigger compaction of the current session: prefer the v2 `session.compact`
	// endpoint, fall back to the v1 `/session/{id}/summarize` path (a real
	// compaction; `auto: true` so the autocontinue hook fires after it). Never
	// throws — returns an error string so the agent sees it. An `error` field
	// in a resolved response counts as a failure.
	const triggerCompact = async (sessionID: string): Promise<string> => {
		let v2Error: string | undefined;
		if (v2Client) {
			try {
				const res = await v2Client.v2.session.compact({ sessionID });
				const err = extractError(res);
				if (err) {
					v2Error = err;
					log(
						"warn",
						"v2 compact failed (server error); falling back to v1 summarize",
						{ sessionID, error: err },
					);
				} else {
					log("warn", "compaction requested via v2 client", { sessionID });
					return "Compaction requested.";
				}
			} catch (err) {
				v2Error = err instanceof Error ? err.message : String(err);
				log("warn", "v2 compact failed; falling back to v1 summarize", {
					sessionID,
					error: v2Error,
				});
			}
		}
		const model = modelCache.get(sessionID);
		if (!model?.providerID || !model?.modelID) {
			const detail = v2Error
				? `${v2Error}; no model info cached for summarize`
				: "no model info cached for summarize";
			log("warn", "compaction request failed", { sessionID, error: detail });
			return `Compaction failed: ${detail}`;
		}
		try {
			const summarize = client.session.summarize({
				path: { id: sessionID },
				// `auto` is not in the generated SDK types but the handler accepts
				// it and fires the autocontinue hook only when it is true.
				body: {
					providerID: model.providerID,
					modelID: model.modelID,
					auto: true,
				} as { providerID: string; modelID: string; auto: boolean },
			});
			const summarizeTimeoutMs =
				seam?.summarizeTimeoutMs ?? DEFAULT_SUMMARIZE_TIMEOUT_MS;
			// Awaiting the summarize to completion self-deadlocks when this tool
			// runs inside a session loop (opencode 1.18.x, upstream #5449): the
			// summarize handler joins the running session-loop fiber, so the
			// response never arrives. Race it instead; on timeout the compaction
			// still proceeds server-side and the loop picks up the persisted
			// compaction task, so we stop waiting and report success.
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const winner = await Promise.race([
					summarize.then(() => "settled"),
					new Promise<string>((resolve) => {
						timer = setTimeout(() => resolve("timeout"), summarizeTimeoutMs);
					}),
				]);
				if (winner === "timeout") {
					// The summarize may still settle later; swallow its outcome so
					// a late rejection is never an unhandled promise rejection.
					summarize.catch((err) => console.log("[context-watch]", err));
					log("warn", "compaction requested via v1 summarize (async)", {
						sessionID,
					});
					return "Compaction requested.";
				}
			} finally {
				clearTimeout(timer);
			}
			const res = await summarize;
			const err = extractError(res);
			if (err) {
				const detail = v2Error ? `${v2Error}; ${err}` : err;
				log("warn", "compaction request failed", { sessionID, error: detail });
				return `Compaction failed: ${detail}`;
			}
			log("warn", "compaction requested via v1 summarize", { sessionID });
			return "Compaction requested.";
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			const combined = v2Error ? `${v2Error}; ${detail}` : detail;
			log("warn", "compaction request failed", { sessionID, error: combined });
			return `Compaction failed: ${combined}`;
		}
	};

	return {
		tool: {
			compact_context: tool({
				description:
					"Compact the current session's context window, freeing space. Call when the session is getting full or the model asks to compact.",
				args: {},
				execute: async (_args, ctx) => triggerCompact(ctx.sessionID),
			}),
		},

		"experimental.compaction.autocontinue": async (input, output) => {
			// Always suppress opencode's synthetic "continue" user message. When
			// postCompactContinue is off, nothing is sent at all after compaction;
			// when on, the configured text is injected as a real, persisted user
			// message instead.
			output.enabled = false;
			if (!opts.postCompactContinue) return;
			client.session
				.promptAsync({
					path: { id: input.sessionID },
					body: {
						agent: input.agent,
						parts: [{ type: "text", text: opts.postCompactMsg }],
					},
				})
				.catch((err) =>
					console.log("[context-watch] compact message injection failed", err),
				);
		},

		"experimental.chat.messages.transform": async (_input, output) => {
			if (problems.length > 0 && !configErrorShown) {
				void configToast();
			}
			const sessionID = output.messages[0]?.info.sessionID;
			if (!sessionID) return;
			const tokens = contextTokens(output.messages);
			if (tokens === undefined) return;

			const window = opts.windowTokens ?? modelCache.get(sessionID)?.window;

			// Threshold checks: warn when EITHER band is crossed. The percent band
			// requires a known model window; when it is unknown only tokens applies.
			const pct = window && window > 0 ? (tokens / window) * 100 : undefined;
			const overPercent = pct !== undefined && pct >= thresholdPct;
			const overTokens = tokens >= opts.warnTokens;
			if (!overPercent && !overTokens) return;

			// Rearm band: only gate the toast + verbose log, NOT the model injection.
			// The injected message is transient per transform call (it is never
			// persisted to the session store), so it must be pushed on EVERY step
			// above threshold — otherwise the final answering step in a multi-step
			// loop (tool calls, etc.) would not see the warning.
			const last = lastWarned.get(sessionID);
			const pctReArmed =
				overPercent &&
				(last?.pct === undefined || (pct ?? 0) - last.pct >= opts.rearmPercent);
			const tokensReArmed =
				overTokens &&
				(last?.tokens === undefined ||
					tokens - last.tokens >= opts.rearmTokens);
			const shouldNotify = pctReArmed || tokensReArmed;
			if (pctReArmed || tokensReArmed) {
				lastWarned.set(sessionID, {
					...last,
					...(pctReArmed && overPercent ? { pct } : {}),
					...(tokensReArmed && overTokens ? { tokens } : {}),
				});
			}

			const text = opts.message
				.replaceAll("{percent}", String(Math.round(pct ?? 0)))
				.replaceAll("{tokens}", tokens.toLocaleString())
				.replaceAll("{window}", window?.toLocaleString() ?? "unknown");

			// Inject a synthetic user message so the warning is visible to the model.
			const stamp = Date.now().toString(36);
			const lastUser = [...output.messages]
				.reverse()
				.find((m) => m.info.role === "user");
			const model =
				lastUser && lastUser.info.role === "user"
					? lastUser.info.model
					: undefined;
			output.messages.push({
				info: {
					id: `msg_cw_${stamp}`,
					sessionID,
					role: "user",
					time: { created: Date.now() },
					agent:
						lastUser && lastUser.info.role === "user"
							? lastUser.info.agent
							: "build",
					model: model ?? { providerID: "opencode", modelID: "context-watch" },
				},
				parts: [
					{
						id: `part_cw_${stamp}`,
						sessionID,
						messageID: `msg_cw_${stamp}`,
						type: "text",
						text,
						synthetic: true,
					},
				],
			});

			if (shouldNotify) {
				const lastPart = output.messages.at(-1)?.parts[0];
				log("warn", "context warning injected", {
					sessionID,
					percent: pct === undefined ? undefined : Math.round(pct),
					messageTokens: tokens,
					window,
					lastMessageText:
						lastPart?.type === "text" ? lastPart.text.slice(0, 80) : "none",
					messageCount: output.messages.length,
				});
				void toast(
					overPercent && pct !== undefined
						? `Context window at ${Math.round(pct)}% — getting full`
						: `Session context reached ${tokens.toLocaleString()} tokens — getting full`,
				);
			}
		},

		"experimental.chat.system.transform": async (input, output) => {
			const sessionID = input.sessionID;
			if (!sessionID) return;
			const cached = modelCache.get(sessionID) ?? {};
			const context = input.model?.limit?.context;
			if (context && context > 0) cached.window = context;
			if (input.model?.providerID) cached.providerID = input.model.providerID;
			if (input.model?.id) cached.modelID = input.model.id;
			modelCache.set(sessionID, cached);
		},
	};
};

export default ContextWatchPlugin;
