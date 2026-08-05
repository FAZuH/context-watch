import { describe, expect, test } from "bun:test";
import {
	type AssistantTokens,
	type Harness,
	buildMessages,
	createHarness,
	must,
} from "./harness";

const WINDOW_KNOWN = JSON.stringify({
	warnPercent: 0.8,
	warnTokens: 1_000_000,
	windowTokens: 100_000,
	rearmPercent: 5,
	rearmTokens: 5_000,
	message: "usage {percent}% {tokens}/{window}",
});

const UNKNOWN_WINDOW = JSON.stringify({
	warnPercent: 0.8,
	warnTokens: 100_000,
	rearmPercent: 5,
	rearmTokens: 5_000,
	message: "usage {percent}% {tokens}/{window}",
});

const SMALL_WINDOW = JSON.stringify({
	warnPercent: 0.5,
	warnTokens: 1_000_000,
	windowTokens: 2_000,
	rearmPercent: 5,
	rearmTokens: 5_000,
	message: "usage {percent}% {tokens}/{window}",
});

async function runTransform(h: Harness, tokens: AssistantTokens) {
	const output = buildMessages(tokens);
	const transform = must(
		h.handlers["experimental.chat.messages.transform"],
		"transform hook",
	);
	await transform({}, output);
	return output;
}

describe("context warning injection", () => {
	test("does not inject a warning below the threshold", async () => {
		const h = await createHarness(WINDOW_KNOWN);
		const output = await runTransform(h, { input: 45_000, output: 5_000 }); // 50% of 100k
		expect(output.messages).toHaveLength(2);
		expect(h.toasts).toHaveLength(0);
		h.cleanup();
	});

	test("injects a synthetic user warning on every transform above the threshold", async () => {
		const h = await createHarness(WINDOW_KNOWN);
		for (let i = 0; i < 2; i++) {
			const output = await runTransform(h, { input: 80_000, output: 10_000 }); // 90%
			expect(output.messages).toHaveLength(3);
			const injected = output.messages[2];
			expect(injected.info.role).toBe("user");
			expect(injected.parts[0]).toMatchObject({
				type: "text",
				synthetic: true,
			});
			expect((injected.parts[0] as { text: string }).text).toBe(
				"usage 90% 90,000/100,000",
			);
		}
		h.cleanup();
	});

	test("fires the band toast once on crossing and only again after a rearm rise", async () => {
		const h = await createHarness(WINDOW_KNOWN);
		await runTransform(h, { input: 80_000, output: 10_000 }); // 90%
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(1);
		await runTransform(h, { input: 82_000, output: 10_000 }); // 92%, rise 2 < rearm
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(1);
		await runTransform(h, { input: 86_000, output: 10_000 }); // 96%, rise 6 >= rearm
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(2);
		h.cleanup();
	});

	test("renders percent and window when the model window is known", async () => {
		const h = await createHarness(WINDOW_KNOWN);
		const output = await runTransform(h, { input: 80_000, output: 10_000 });
		const text = (output.messages[2].parts[0] as { text: string }).text;
		expect(text).toBe("usage 90% 90,000/100,000");
		h.cleanup();
	});

	test("uses the tokens band and renders an unknown window when the window is unknown", async () => {
		const h = await createHarness(UNKNOWN_WINDOW);
		const output = await runTransform(h, { input: 110_000, output: 10_000 }); // 120k >= warnTokens
		const text = (output.messages[2].parts[0] as { text: string }).text;
		expect(text).toBe("usage 0% 120,000/unknown");
		expect(h.toasts.filter((t) => t.variant === "warning")).toHaveLength(1);
		expect(h.toasts[0].message).toContain("120,000");
		h.cleanup();
	});

	test("counts reasoning and cache tokens toward the context size", async () => {
		const h = await createHarness(SMALL_WINDOW);
		const output = await runTransform(h, {
			input: 1_000,
			output: 100,
			reasoning: 50,
			cache: { read: 200, write: 50 },
		}); // 1400 total = 70% of 2000
		const text = (output.messages[2].parts[0] as { text: string }).text;
		expect(text).toBe("usage 70% 1,400/2,000");
		h.cleanup();
	});
});
