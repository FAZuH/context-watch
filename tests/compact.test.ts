import { describe, expect, test } from "bun:test";
import { buildMessages, createHarness, must, seedModel } from "./harness";

interface FakeV2Result {
	client: {
		v2: {
			session: {
				compact: (p: { sessionID: string }) => Promise<unknown>;
			};
		};
	};
	calls: { sessionID: string }[];
}

function fakeV2Client(reject: boolean, resolve?: unknown): FakeV2Result {
	const calls: { sessionID: string }[] = [];
	const client = {
		v2: {
			session: {
				compact: async (params: { sessionID: string }) => {
					calls.push(params);
					if (reject) throw new Error("v2 compact rejected");
					if (resolve !== undefined) return resolve;
					return {};
				},
			},
		},
	};
	return { client, calls };
}

const TOOL_CTX = { sessionID: "s1" } as never;

const MODEL = {
	providerID: "opencode",
	modelID: "deepseek-v4-flash-free",
	window: 200_000,
};

const V2_STUB_ERROR = {
	error: { message: "Session compact is not available yet" },
	response: {},
};

describe("compact_context tool", () => {
	test("registers a tool with a description and an execute function", async () => {
		const h = await createHarness(null);
		const t = h.handlers.tool?.compact_context;
		expect(t).toBeDefined();
		expect(t?.description).toContain("Compact the current session");
		expect(typeof t?.execute).toBe("function");
		h.cleanup();
	});

	test("calls the v2 compact endpoint with the sessionID and returns a success string", async () => {
		const { client, calls } = fakeV2Client(false);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
		});
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		expect(calls).toEqual([{ sessionID: "s1" }]);
		expect(result).toBe("Compaction requested.");
		expect(h.sessionSummarizes).toHaveLength(0);
		h.cleanup();
	});

	test("falls back to the v1 summarize when the v2 call rejects", async () => {
		const { client } = fakeV2Client(true);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
		});
		await seedModel(h, "s1", MODEL);
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		expect(h.sessionSummarizes).toEqual([
			{
				sessionID: "s1",
				providerID: "opencode",
				modelID: "deepseek-v4-flash-free",
				auto: true,
			},
		]);
		expect(result).toBe("Compaction requested.");
		h.cleanup();
	});

	test("falls back to the v1 summarize when the v2 client factory throws", async () => {
		const h = await createHarness(null, {
			createOpencodeClientV2: () => {
				throw new Error("v2 client unavailable");
			},
		});
		await seedModel(h, "s1", MODEL);
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		expect(h.sessionSummarizes).toEqual([
			{
				sessionID: "s1",
				providerID: "opencode",
				modelID: "deepseek-v4-flash-free",
				auto: true,
			},
		]);
		expect(result).toBe("Compaction requested.");
		h.cleanup();
	});

	test("falls back to the v1 summarize when the v2 call resolves an error (1.18.11 stub)", async () => {
		const { client, calls } = fakeV2Client(false, V2_STUB_ERROR);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
		});
		await seedModel(h, "s1", MODEL);
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		expect(calls).toEqual([{ sessionID: "s1" }]);
		expect(h.sessionSummarizes).toEqual([
			{
				sessionID: "s1",
				providerID: "opencode",
				modelID: "deepseek-v4-flash-free",
				auto: true,
			},
		]);
		expect(result).toBe("Compaction requested.");
		h.cleanup();
	});

	test("returns 'Compaction requested.' promptly when the v1 summarize hangs (fire-and-forget, no deadlock)", async () => {
		const { client } = fakeV2Client(false, V2_STUB_ERROR);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
			sessionSummarizeHang: true,
			summarizeTimeoutMs: 50,
		});
		await seedModel(h, "s1", MODEL);
		const started = Date.now();
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		const elapsed = Date.now() - started;
		expect(result).toBe("Compaction requested.");
		expect(elapsed).toBeLessThan(1000);
		expect(h.sessionSummarizeCalls()).toBe(1);
		h.cleanup();
	});

	test("fails honestly when no model info is cached and the v2 path also failed", async () => {
		const { client } = fakeV2Client(false, V2_STUB_ERROR);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
		});
		const result = String(
			await must(
				h.handlers.tool?.compact_context,
				"compact_context tool",
			).execute({}, TOOL_CTX),
		);
		expect(result.startsWith("Compaction failed:")).toBe(true);
		expect(result).toContain("Session compact is not available yet");
		expect(h.sessionSummarizes).toHaveLength(0);
		h.cleanup();
	});

	test("fails honestly when no v2 client and no model info are available", async () => {
		const h = await createHarness(null, {
			createOpencodeClientV2: () => {
				throw new Error("v2 client unavailable");
			},
		});
		const result = String(
			await must(
				h.handlers.tool?.compact_context,
				"compact_context tool",
			).execute({}, TOOL_CTX),
		);
		expect(result).toBe(
			"Compaction failed: no model info cached for summarize",
		);
		expect(h.sessionSummarizes).toHaveLength(0);
		h.cleanup();
	});

	test("returns a combined failure when the v2 call rejects and summarize throws", async () => {
		const { client } = fakeV2Client(true);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
			failSessionSummarize: true,
		});
		await seedModel(h, "s1", MODEL);
		const result = String(
			await must(
				h.handlers.tool?.compact_context,
				"compact_context tool",
			).execute({}, TOOL_CTX),
		);
		expect(result).toBe(
			"Compaction failed: v2 compact rejected; summarize rejected",
		);
		h.cleanup();
	});

	test("returns a failure string when v2 resolves an error and summarize resolves an error", async () => {
		const { client } = fakeV2Client(false, V2_STUB_ERROR);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
			sessionSummarizeResolved: {
				error: { name: "UnknownError", data: { message: "nope" } },
				response: {},
			},
		});
		await seedModel(h, "s1", MODEL);
		const result = String(
			await must(
				h.handlers.tool?.compact_context,
				"compact_context tool",
			).execute({}, TOOL_CTX),
		);
		expect(result.startsWith("Compaction failed:")).toBe(true);
		expect(result).toContain("Session compact is not available yet");
		expect(result).not.toBe("Compaction requested.");
		h.cleanup();
	});

	test("captures providerID and modelID via system.transform and uses the cached window", async () => {
		const { client } = fakeV2Client(true);
		const h = await createHarness(null, {
			createOpencodeClientV2: () => client,
		});
		await seedModel(h, "s1", {
			providerID: "anthropic",
			modelID: "claude-sonnet-4",
			window: 200_000,
		});
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		expect(h.sessionSummarizes).toEqual([
			{
				sessionID: "s1",
				providerID: "anthropic",
				modelID: "claude-sonnet-4",
				auto: true,
			},
		]);
		expect(result).toBe("Compaction requested.");
		// the cached window still drives messages.transform (80% of 200k)
		const transform = must(
			h.handlers["experimental.chat.messages.transform"],
			"transform hook",
		);
		const output = buildMessages({ input: 150_000, output: 10_000 }, "s1");
		await transform({}, output);
		const text = (output.messages[2].parts[0] as { text: string }).text;
		expect(text).toContain("160,000/200,000");
		h.cleanup();
	});
});

describe("experimental.compaction.autocontinue", () => {
	const AUTO_INPUT = {
		sessionID: "s1",
		agent: "build",
		model: {},
		provider: {},
		message: {},
		overflow: false,
	} as never;

	test("with postCompactContinue on, disables the synthetic continue and injects the configured text", async () => {
		const h = await createHarness(
			JSON.stringify({
				postCompactContinue: true,
				postCompactMsg: "resume work from here",
			}),
		);
		const hook = must(
			h.handlers["experimental.compaction.autocontinue"],
			"autocontinue hook",
		);
		const output = { enabled: true };
		await hook(AUTO_INPUT, output);
		expect(output.enabled).toBe(false);
		expect(h.sessionPrompts).toEqual([
			{ sessionID: "s1", text: "resume work from here", agent: "build" },
		]);
		h.cleanup();
	});

	test("with postCompactContinue off, disables the synthetic continue and injects nothing", async () => {
		const h = await createHarness(null);
		const hook = must(
			h.handlers["experimental.compaction.autocontinue"],
			"autocontinue hook",
		);
		const output = { enabled: true };
		await hook(AUTO_INPUT, output);
		expect(output.enabled).toBe(false);
		expect(h.sessionPrompts).toHaveLength(0);
		h.cleanup();
	});

	test("injects the compact message after a summarize-triggered compaction", async () => {
		const { client } = fakeV2Client(true);
		const h = await createHarness(
			JSON.stringify({
				postCompactContinue: true,
				postCompactMsg: "resume work from here",
			}),
			{ createOpencodeClientV2: () => client },
		);
		await seedModel(h, "s1", MODEL);
		const result = await must(
			h.handlers.tool?.compact_context,
			"compact_context tool",
		).execute({}, TOOL_CTX);
		expect(result).toBe("Compaction requested.");
		expect(h.sessionSummarizes).toHaveLength(1);
		const hook = must(
			h.handlers["experimental.compaction.autocontinue"],
			"autocontinue hook",
		);
		const output = { enabled: true };
		await hook(AUTO_INPUT, output);
		expect(output.enabled).toBe(false);
		expect(h.sessionPrompts).toEqual([
			{ sessionID: "s1", text: "resume work from here", agent: "build" },
		]);
		h.cleanup();
	});
});
