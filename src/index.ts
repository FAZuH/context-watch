/**
 * context-watch — opencode plugin
 *
 * Warns the agent when a session's context window usage crosses a threshold,
 * so you can wrap up the current step or prepare for compaction before the
 * window is full. Warns again as usage rises through each rearm band.
 *
 * Default thresholds: 77% of the model's context window, or 100k tokens —
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
 * Config file (optional): ~/.config/opencode/context-watch.json
 * {
 *   "warnPercent": 0.77,     // 0..1, or percent (e.g. 77) if > 1
 *   "warnTokens": 100000,    // warn when session reaches this many tokens
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
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"

interface ContextWatchOptions {
  warnPercent?: number
  warnTokens?: number
  windowTokens?: number | null
  rearmPercent?: number
  rearmTokens?: number
  toast?: boolean
  verbose?: boolean
  message?: string
}

const CONFIG_PATH = join(homedir(), ".config/opencode/context-watch.json")

const DEFAULTS = {
  warnPercent: 0.77,
  warnTokens: 100_000,
  windowTokens: null as number | null,
  rearmPercent: 5,
  rearmTokens: 5_000,
  toast: true,
  verbose: false,
  message:
    "[context-watch] Context window usage is at {percent}% ({tokens}/{window} tokens). The session is getting full: wrap up the current step soon, keep replies concise, avoid re-reading large files, and be ready to prepare for compaction if you continue.",
}

function loadOptions(): Required<ContextWatchOptions> {
  let file: ContextWatchOptions = {}
  try {
    if (existsSync(CONFIG_PATH)) {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    }
  } catch (err) {
    console.log("[context-watch] failed to read config file", CONFIG_PATH, err)
  }

  const rawPercent = Number(
    process.env.CONTEXT_WATCH_PERCENT ?? file.warnPercent ?? DEFAULTS.warnPercent,
  )
  const rawTokens = Number(process.env.CONTEXT_WATCH_TOKENS ?? file.warnTokens ?? DEFAULTS.warnTokens)
  const windowRaw = Number(process.env.CONTEXT_WATCH_WINDOW ?? file.windowTokens ?? 0)
  const rearm = Number(process.env.CONTEXT_WATCH_REARM ?? file.rearmPercent ?? DEFAULTS.rearmPercent)
  const rearmTokens = Number(
    process.env.CONTEXT_WATCH_REARM_TOKENS ?? file.rearmTokens ?? DEFAULTS.rearmTokens,
  )

  return {
    warnPercent: rawPercent > 1 ? rawPercent / 100 : rawPercent,
    warnTokens: rawTokens,
    windowTokens: windowRaw > 0 ? windowRaw : null,
    rearmPercent: rearm,
    rearmTokens,
    toast: process.env.CONTEXT_WATCH_NO_TOAST
      ? false
      : (file.toast ?? DEFAULTS.toast),
    verbose: file.verbose ?? DEFAULTS.verbose,
    message: process.env.CONTEXT_WATCH_MESSAGE ?? file.message ?? DEFAULTS.message,
  }
}

/**
 * Return the provider-reported context size, matching opencode's TUI context
 * meter: the most recent completed assistant message's
 * `input + output + reasoning + cache.read + cache.write`. This is the ground
 * truth for how full the window actually is.
 */
function contextTokens(messages: { info: Message; parts: Part[] }[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info.role !== "assistant") continue
    const t = info.tokens
    if (!t || !t.input || t.input <= 0) continue
    if (!t.output || t.output <= 0) continue
    return t.input + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  }
  return undefined
}

export const ContextWatchPlugin: Plugin = async ({ client }) => {
  const opts = loadOptions()
  const thresholdPct = opts.warnPercent * 100

  // sessionID -> model context window, cached by system.transform (messages.transform has no model info)
  const windowCache = new Map<string, number>()
  // sessionID -> last warned value per band, to rearm only after a rise
  const lastWarned = new Map<string, { pct?: number; tokens?: number }>()

  const toast = async (text: string) => {
    if (!opts.toast) return
    try {
      await client.tui.showToast({ body: { message: text, variant: "warning" } })
    } catch (err) {
      console.log("[context-watch]", text)
    }
  }

  const log = (level: "debug" | "warn", message: string, extra: Record<string, unknown>) => {
    if (!opts.verbose) return
    console.log("[context-watch]", message, JSON.stringify(extra))
    client.app
      .log({ body: { service: "context-watch", level, message, extra } })
      .catch(() => {})
  }

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages[0]?.info.sessionID
      if (!sessionID) return
      const tokens = contextTokens(output.messages)
      if (tokens === undefined) return

      const window = opts.windowTokens ?? windowCache.get(sessionID)

      // Threshold checks: warn when EITHER band is crossed. The percent band
      // requires a known model window; when it is unknown only tokens applies.
      const pct = window && window > 0 ? (tokens / window) * 100 : undefined
      const overPercent = pct !== undefined && pct >= thresholdPct
      const overTokens = tokens >= opts.warnTokens
      if (!overPercent && !overTokens) return

      // Rearm band: only gate the toast + verbose log, NOT the model injection.
      // The injected message is transient per transform call (it is never
      // persisted to the session store), so it must be pushed on EVERY step
      // above threshold — otherwise the final answering step in a multi-step
      // loop (tool calls, etc.) would not see the warning.
      const last = lastWarned.get(sessionID)
      const pctReArmed = overPercent && (last?.pct === undefined || pct! - last.pct >= opts.rearmPercent)
      const tokensReArmed = overTokens && (last?.tokens === undefined || tokens - last.tokens >= opts.rearmTokens)
      const shouldNotify = pctReArmed || tokensReArmed
      if (pctReArmed || tokensReArmed) {
        lastWarned.set(sessionID, {
          ...last,
          ...(pctReArmed && overPercent ? { pct } : {}),
          ...(tokensReArmed && overTokens ? { tokens } : {}),
        })
      }

      const text = opts.message
        .replaceAll("{percent}", String(Math.round(pct ?? 0)))
        .replaceAll("{tokens}", tokens.toLocaleString())
        .replaceAll("{window}", window?.toLocaleString() ?? "unknown")

      // Inject a synthetic user message so the warning is visible to the model.
      const stamp = Date.now().toString(36)
      const lastUser = [...output.messages].reverse().find((m) => m.info.role === "user")
      const model = lastUser && lastUser.info.role === "user" ? lastUser.info.model : undefined
      output.messages.push({
        info: {
          id: `msg_cw_${stamp}`,
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: lastUser && lastUser.info.role === "user" ? lastUser.info.agent : "build",
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
      })

      if (shouldNotify) {
        log("warn", "context warning injected", {
          sessionID,
          percent: pct === undefined ? undefined : Math.round(pct),
          messageTokens: tokens,
          window,
          lastMessageText: output.messages.at(-1)?.parts[0]?.type === "text" ? (output.messages.at(-1)!.parts[0] as { text: string }).text.slice(0, 80) : "none",
          messageCount: output.messages.length,
        })
        void toast(
          overPercent
            ? `Context window at ${Math.round(pct!)}% — getting full`
            : `Session context reached ${tokens.toLocaleString()} tokens — getting full`,
        )
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input.sessionID
      if (!sessionID) return
      const window = input.model?.limit?.context
      if (window && window > 0) windowCache.set(sessionID, window)
    },
  }
}

export default ContextWatchPlugin
