import { describe, expect, test } from "bun:test";
import { createHarness, must } from "./harness";

const BAD_JSON = "{ not json !!";
const INVALID_TYPES = JSON.stringify({
	warnPercent: "abc",
	warnTokens: -1,
	toast: "yes",
});

describe("config error toast", () => {
	test("valid config produces no toast and no error log", async () => {
		const h = await createHarness(JSON.stringify({ warnPercent: 0.5 }));
		expect(h.toasts).toHaveLength(0);
		expect(h.appLogs.filter((l) => l.level === "error")).toHaveLength(0);
		h.cleanup();
	});

	test("invalid config shows one error toast listing each problem", async () => {
		const h = await createHarness(INVALID_TYPES);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0].variant).toBe("error");
		expect(h.toasts[0].message).toContain("warnPercent");
		expect(h.toasts[0].message).toContain("warnTokens");
		expect(h.toasts[0].message).toContain("toast");
		h.cleanup();
	});

	test("invalid config writes the problems to the opencode log", async () => {
		const h = await createHarness(INVALID_TYPES);
		const err = h.appLogs.find((l) => l.level === "error");
		expect(err).toBeDefined();
		expect(err?.message).toBe("invalid config");
		const keys = (err?.extra as { problems: { key: string }[] }).problems.map(
			(p) => p.key,
		);
		expect(keys).toEqual(["warnPercent", "warnTokens", "toast"]);
		h.cleanup();
	});

	test("bad JSON reports the parse error in the toast", async () => {
		const h = await createHarness(BAD_JSON);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0].message).toContain("not valid JSON");
		h.cleanup();
	});

	test("config-error toast fires even when the file disables toasts", async () => {
		const h = await createHarness(
			JSON.stringify({ toast: false, warnPercent: "abc" }),
		);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0].variant).toBe("error");
		h.cleanup();
	});

	test("an invalid env override is cited in the toast", async () => {
		const h = await createHarness(null, {
			env: { CONTEXT_WATCH_PERCENT: "oops" },
		});
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0].message).toContain("CONTEXT_WATCH_PERCENT");
		h.cleanup();
	});

	test("a load-time toast failure does not crash and retries once on the first transform", async () => {
		const h = await createHarness(BAD_JSON, { failFirstToast: true });
		const transform = must(
			h.handlers["experimental.chat.messages.transform"],
			"transform hook",
		);
		await transform({}, { messages: [] });
		await transform({}, { messages: [] });
		// one failed attempt at load + one successful retry on the first transform
		expect(h.showToastCalls()).toBe(2);
		expect(h.toasts).toHaveLength(1);
		expect(h.toasts[0].variant).toBe("error");
		h.cleanup();
	});

	test("dedupes across transforms once the error toast has been shown", async () => {
		const h = await createHarness(BAD_JSON);
		const transform = must(
			h.handlers["experimental.chat.messages.transform"],
			"transform hook",
		);
		for (let i = 0; i < 3; i++) await transform({}, { messages: [] });
		expect(h.showToastCalls()).toBe(1);
		expect(h.toasts).toHaveLength(1);
		h.cleanup();
	});
});
