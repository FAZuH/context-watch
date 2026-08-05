import { describe, expect, test } from "bun:test";
import { type ConfigProblem, resolveOptions } from "../src/index";

const EMPTY_ENV: Record<string, string> = {};

const problems = (
	raw: unknown,
	env: Record<string, string | undefined> = EMPTY_ENV,
): ConfigProblem[] => resolveOptions(raw, env).problems;

const options = (
	raw: unknown,
	env: Record<string, string | undefined> = EMPTY_ENV,
) => resolveOptions(raw, env).options;

const hasProblemFor = (list: ConfigProblem[], key: string): boolean =>
	list.some((p) => p.key === key);

describe("resolveOptions", () => {
	describe("defaults", () => {
		test("returns all defaults and no problems for an empty config", () => {
			const { options: o, problems: ps } = resolveOptions({}, EMPTY_ENV);
			expect(ps).toEqual([]);
			expect(o.warnPercent).toBe(0.77);
			expect(o.warnTokens).toBe(150_000);
			expect(o.windowTokens).toBeNull();
			expect(o.rearmPercent).toBe(5);
			expect(o.rearmTokens).toBe(5_000);
			expect(o.toast).toBe(true);
			expect(o.verbose).toBe(false);
			expect(o.message).toContain("{percent}");
			expect(o.message).toContain("{tokens}");
			expect(o.message).toContain("{window}");
		});

		test("treats a missing config file the same as an empty one", () => {
			const { options: o, problems: ps } = resolveOptions({}, EMPTY_ENV);
			expect(ps).toEqual([]);
			expect(o.warnPercent).toBe(0.77);
		});
	});

	describe("warnPercent", () => {
		test("accepts a fraction and normalizes a percent value", () => {
			expect(options({ warnPercent: 0.5 }).warnPercent).toBe(0.5);
			expect(options({ warnPercent: 77 }).warnPercent).toBe(0.77);
		});

		test("accepts the boundary values 1 and 100", () => {
			expect(options({ warnPercent: 1 }).warnPercent).toBe(1);
			expect(options({ warnPercent: 100 }).warnPercent).toBe(1);
		});

		test.each([
			["zero", 0],
			["negative", -10],
			["over one hundred", 150],
			["non-numeric string", "abc"],
		])("rejects %s and falls back to the default", (_label, value) => {
			const { options: o, problems: ps } = resolveOptions(
				{ warnPercent: value },
				EMPTY_ENV,
			);
			expect(o.warnPercent).toBe(0.77);
			expect(hasProblemFor(ps, "warnPercent")).toBe(true);
		});
	});

	describe("warnTokens", () => {
		test("accepts a positive number", () => {
			expect(options({ warnTokens: 50_000 }).warnTokens).toBe(50_000);
		});

		test.each([
			["zero", 0],
			["negative", -100],
			["non-numeric string", "5k"],
		])("rejects %s and falls back to the default", (_label, value) => {
			const { options: o, problems: ps } = resolveOptions(
				{ warnTokens: value },
				EMPTY_ENV,
			);
			expect(o.warnTokens).toBe(150_000);
			expect(hasProblemFor(ps, "warnTokens")).toBe(true);
		});
	});

	describe("windowTokens", () => {
		test("accepts a positive number or null", () => {
			expect(options({ windowTokens: 200_000 }).windowTokens).toBe(200_000);
			expect(options({ windowTokens: null }).windowTokens).toBeNull();
		});

		test.each([
			["negative", -5],
			["zero", 0],
			["non-numeric string", "abc"],
		])("rejects %s and falls back to the default", (_label, value) => {
			const { options: o, problems: ps } = resolveOptions(
				{ windowTokens: value },
				EMPTY_ENV,
			);
			expect(o.windowTokens).toBeNull();
			expect(hasProblemFor(ps, "windowTokens")).toBe(true);
		});
	});

	describe("rearmPercent and rearmTokens", () => {
		test("accepts positive numbers", () => {
			expect(
				options({ rearmPercent: 2, rearmTokens: 1_000 }).rearmPercent,
			).toBe(2);
			expect(options({ rearmPercent: 2, rearmTokens: 1_000 }).rearmTokens).toBe(
				1_000,
			);
		});

		test.each([
			["rearmPercent", "rearmPercent", 0],
			["rearmPercent", "rearmPercent", -3],
			["rearmTokens", "rearmTokens", 0],
		])("rejects non-positive %s", (_label, key, value) => {
			const { options: o, problems: ps } = resolveOptions(
				{ [key]: value },
				EMPTY_ENV,
			);
			expect(hasProblemFor(ps, key)).toBe(true);
			expect(o[key as keyof typeof o]).toBe(key === "rearmPercent" ? 5 : 5_000);
		});
	});

	describe("toast and verbose", () => {
		test("accepts booleans", () => {
			expect(options({ toast: false, verbose: true }).toast).toBe(false);
			expect(options({ toast: false, verbose: true }).verbose).toBe(true);
		});

		test.each([
			["toast", "toast"],
			["verbose", "verbose"],
		])("rejects a non-boolean %s", (_label, key) => {
			const { options: o, problems: ps } = resolveOptions(
				{ [key]: "yes" },
				EMPTY_ENV,
			);
			expect(hasProblemFor(ps, key)).toBe(true);
			expect(o[key as keyof typeof o]).toBe(key === "toast");
		});
	});

	describe("message", () => {
		test("accepts a non-empty string", () => {
			const custom = "custom {percent} template";
			expect(options({ message: custom }).message).toBe(custom);
		});

		test.each([
			["a number", 42],
			["an empty string", ""],
			["whitespace only", "   "],
		])("rejects %s and falls back to the default", (_label, value) => {
			const { options: o, problems: ps } = resolveOptions(
				{ message: value },
				EMPTY_ENV,
			);
			expect(o.message).toContain("{percent}");
			expect(hasProblemFor(ps, "message")).toBe(true);
		});
	});

	describe("unknown keys and root shape", () => {
		test("flags unknown keys but keeps known ones", () => {
			const { options: o, problems: ps } = resolveOptions(
				{ warnPercent: 0.5, warnTokens: 1_000, toastt: true },
				EMPTY_ENV,
			);
			expect(hasProblemFor(ps, "toastt")).toBe(true);
			expect(o.warnPercent).toBe(0.5);
			expect(o.warnTokens).toBe(1_000);
		});

		test.each([
			["an array", []],
			["a string", "config"],
			["null", null],
			["a number", 7],
		])("reports a problem when the root is %s", (_label, raw) => {
			const { options: o, problems: ps } = resolveOptions(raw, EMPTY_ENV);
			expect(hasProblemFor(ps, "file")).toBe(true);
			expect(o.warnPercent).toBe(0.77);
		});
	});

	describe("env precedence", () => {
		test("env overrides the file value", () => {
			const { options: o } = resolveOptions(
				{ warnPercent: 0.5 },
				{ CONTEXT_WATCH_PERCENT: "60" },
			);
			expect(o.warnPercent).toBe(0.6);
		});

		test("an invalid env value falls back to the file value and cites the env var", () => {
			const { options: o, problems: ps } = resolveOptions(
				{ warnTokens: 50_000 },
				{ CONTEXT_WATCH_TOKENS: "oops" },
			);
			expect(o.warnTokens).toBe(50_000);
			const msg = ps.find((p) => p.key === "warnTokens")?.message ?? "";
			expect(msg).toContain("CONTEXT_WATCH_TOKENS");
			expect(msg).toContain("oops");
		});

		test("invalid env and invalid file both report and fall back to the default", () => {
			const { options: o, problems: ps } = resolveOptions(
				{ warnPercent: -1 },
				{ CONTEXT_WATCH_PERCENT: "nope" },
			);
			expect(o.warnPercent).toBe(0.77);
			expect(ps.filter((p) => p.key === "warnPercent")).toHaveLength(2);
		});

		test("CONTEXT_WATCH_NO_TOAST presence forces toast off even when the file says true", () => {
			expect(
				resolveOptions({ toast: true }, { CONTEXT_WATCH_NO_TOAST: "1" }).options
					.toast,
			).toBe(false);
		});

		test("CONTEXT_WATCH_MESSAGE overrides the file message", () => {
			const { options: o } = resolveOptions(
				{ message: "file message" },
				{ CONTEXT_WATCH_MESSAGE: "env message" },
			);
			expect(o.message).toBe("env message");
		});

		test("env window override is accepted and invalid env falls back to file", () => {
			expect(
				resolveOptions({}, { CONTEXT_WATCH_WINDOW: "200000" }).options
					.windowTokens,
			).toBe(200_000);
			const withFile = resolveOptions(
				{ windowTokens: 100_000 },
				{ CONTEXT_WATCH_WINDOW: "abc" },
			);
			expect(withFile.options.windowTokens).toBe(100_000);
			expect(hasProblemFor(withFile.problems, "windowTokens")).toBe(true);
		});
	});

	describe("multiple problems", () => {
		test("collects one problem per bad value", () => {
			const { problems: ps } = resolveOptions(
				{ warnPercent: "abc", warnTokens: -1, toast: 5, bogus: 1 },
				EMPTY_ENV,
			);
			expect(ps.map((p) => p.key).sort()).toEqual([
				"bogus",
				"toast",
				"warnPercent",
				"warnTokens",
			]);
		});
	});
});
