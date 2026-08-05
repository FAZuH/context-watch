/**
 * opencode-context-watch — opencode plugin
 *
 * Warns the agent when a session's context window usage crosses a threshold,
 * so you can wrap up the current step or prepare for compaction before the
 * window is full. Warns again as usage rises through each rearm band.
 *
 * Default thresholds: 77% of the model's context window, or 150k tokens —
 * whichever comes first.
 *
 * How it works:
 * - `experimental.chat.messages.transform` runs each turn with the full
 *   assembled context. It reads the real context size from the most recent
 *   completed assistant message's provider-reported token counts (the same
 *   number opencode's TUI context meter shows), then — when the threshold is
 *   crossed — pushes a synthetic user message into `output.messages` so the
 *   warning is visible to the model as part of the conversation.
 * - `experimental.chat.system.transform` runs in the same turn with the model
 *   metadata; it caches the real window from `model.limit.context` because
 *   `messages.transform` does not receive model info.
 *
 * Config file (optional): ~/.config/opencode/opencode-context-watch.json
 * {
 *   "warnPercent": 0.77,     // 0..1, or percent (e.g. 77) if > 1
 *   "warnTokens": 150000,    // warn when session reaches this many tokens
 *   "windowTokens": null,    // override the model's context window (tokens)
 *   "rearmPercent": 5,       // re-warn after this many percentage-point rise
 *   "rearmTokens": 5000,     // re-warn after this many more tokens
 *   "toast": true,           // show a TUI toast when a band is crossed
 *   "verbose": false,        // log context estimates to the opencode log
 *   "message": "..."         // template; placeholders {percent} {tokens} {window}
 * }
 *
 * Env overrides: CONTEXT_WATCH_PERCENT, CONTEXT_WATCH_TOKENS,
 * CONTEXT_WATCH_WINDOW, CONTEXT_WATCH_REARM, CONTEXT_WATCH_REARM_TOKENS,
 * CONTEXT_WATCH_MESSAGE, CONTEXT_WATCH_NO_TOAST
 *
 * If the config file or an env override is invalid — bad JSON, wrong types,
 * out-of-range values, unknown keys — the plugin falls back to the default for
 * each bad value and shows a TUI error toast listing what is wrong (full
 * detail is also written to the opencode log).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
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
}

interface ConfigProblem {
	key: string;
	message: string;
}

export type { ConfigProblem };

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
]);

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
		const envValue = env[envName];
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
		const envValue = env.CONTEXT_WATCH_WINDOW;
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
	if (env.CONTEXT_WATCH_MESSAGE !== undefined) {
		message = env.CONTEXT_WATCH_MESSAGE;
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

	return {
		options: {
			warnPercent: warnPercent > 1 ? warnPercent / 100 : warnPercent,
			warnTokens,
			windowTokens,
			rearmPercent,
			rearmTokens,
			toast: env.CONTEXT_WATCH_NO_TOAST ? false : bool("toast", DEFAULTS.toast),
			verbose: bool("verbose", DEFAULTS.verbose),
			message,
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

export const ContextWatchPlugin: Plugin = async ({ client }, pluginOptions) => {
	// `configPath` is a test-only seam; opencode always uses the default path.
	const configPath = (pluginOptions as { configPath?: string } | undefined)
		?.configPath;
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

	// sessionID -> model context window, cached by system.transform (messages.transform has no model info)
	const windowCache = new Map<string, number>();
	// sessionID -> last warned value per band, to rearm only after a rise
	const lastWarned = new Map<string, { pct?: number; tokens?: number }>();

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

	return {
		"experimental.chat.messages.transform": async (_input, output) => {
			if (problems.length > 0 && !configErrorShown) {
				void configToast();
			}
			const sessionID = output.messages[0]?.info.sessionID;
			if (!sessionID) return;
			const tokens = contextTokens(output.messages);
			if (tokens === undefined) return;

			const window = opts.windowTokens ?? windowCache.get(sessionID);

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
				(last?.pct === undefined || pct! - last.pct >= opts.rearmPercent);
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
				log("warn", "context warning injected", {
					sessionID,
					percent: pct === undefined ? undefined : Math.round(pct),
					messageTokens: tokens,
					window,
					lastMessageText:
						output.messages.at(-1)?.parts[0]?.type === "text"
							? (
									output.messages.at(-1)!.parts[0] as { text: string }
								).text.slice(0, 80)
							: "none",
					messageCount: output.messages.length,
				});
				void toast(
					overPercent
						? `Context window at ${Math.round(pct!)}% — getting full`
						: `Session context reached ${tokens.toLocaleString()} tokens — getting full`,
				);
			}
		},

		"experimental.chat.system.transform": async (input, output) => {
			const sessionID = input.sessionID;
			if (!sessionID) return;
			const window = input.model?.limit?.context;
			if (window && window > 0) windowCache.set(sessionID, window);
		},
	};
};

export default ContextWatchPlugin;
