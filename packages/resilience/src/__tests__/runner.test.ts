import { describe, expect, it, vi } from "vitest";
import { createRunner } from "../runner";
import type { Action, RunnerConfig, StepContext } from "../types";

function makeCtx(page = {}): StepContext {
	return { page, data: new Map() };
}

function makeConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
	return {
		onError: () => ({ action: "fail" }),
		...overrides,
	};
}

describe("Runner", () => {
	// 1. Happy path
	it("completes with all steps successful when no errors thrown", async () => {
		const runner = createRunner(makeConfig());

		runner
			.step({ description: "step 1", fn: async () => {} })
			.step({ description: "step 2", fn: async () => {} });

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("completed");
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0]).toEqual({ description: "step 1", status: "success" });
		expect(result.steps[1]).toEqual({ description: "step 2", status: "success" });
	});

	// 2. Abort on error
	it("aborts when onError returns abort, skips remaining steps, fires onAbort", async () => {
		const onAbort = vi.fn();
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "abort" }),
				onAbort,
			}),
		);

		runner
			.step({ description: "step 1", fn: async () => {} })
			.step({
				description: "step 2",
				fn: async () => {
					throw new Error("bad credentials");
				},
			})
			.step({ description: "step 3", fn: async () => {} });

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("aborted");
		expect(result.steps[0].status).toBe("success");
		expect(result.steps[1].status).toBe("failed");
		expect(result.steps[2].status).toBe("skipped");
		expect(onAbort).toHaveBeenCalledOnce();
		expect(onAbort).toHaveBeenCalledWith("step 2", expect.any(Error), expect.any(Object));
	});

	// 3. Fail and continue
	it("marks step as failed and continues to next step when onError returns fail", async () => {
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "fail" }),
			}),
		);

		runner
			.step({
				description: "step 1",
				fn: async () => {
					throw new Error("non-critical");
				},
			})
			.step({ description: "step 2", fn: async () => {} });

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("completed");
		expect(result.steps[0].status).toBe("failed");
		expect(result.steps[1].status).toBe("success");
	});

	// 4. Retry succeeds
	it("retries step and succeeds when step passes on a subsequent attempt", async () => {
		let callCount = 0;
		const onRetry = vi.fn();
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 3, backoffMs: 1 }),
				onRetry,
			}),
		);

		runner.step({
			description: "flaky step",
			fn: async () => {
				callCount++;
				if (callCount < 3) throw new Error("timeout");
			},
		});

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("completed");
		expect(result.steps[0].status).toBe("success");
		expect(onRetry).toHaveBeenCalledTimes(2);
	});

	// 5. Retry exhausted
	it("marks step as failed and fires onStepFail when retries are exhausted", async () => {
		const onStepFail = vi.fn();
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 2, backoffMs: 1 }),
				onStepFail,
			}),
		);

		runner.step({
			description: "always fails",
			fn: async () => {
				throw new Error("timeout");
			},
		});

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("completed");
		expect(result.steps[0].status).toBe("failed");
		expect(onStepFail).toHaveBeenCalledOnce();
		expect(onStepFail).toHaveBeenCalledWith("always fails", expect.any(Error), expect.any(Object));
	});

	// 6. onRetry fires before attempt
	it("fires onRetry before the step re-runs", async () => {
		const callOrder: string[] = [];
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 1, backoffMs: 1 }),
				onRetry: () => callOrder.push("onRetry"),
			}),
		);

		let attempt = 0;
		runner.step({
			description: "ordered step",
			fn: async () => {
				callOrder.push(`fn-${attempt}`);
				attempt++;
				if (attempt < 2) throw new Error("fail");
			},
		});

		await runner.run(makeCtx());

		expect(callOrder).toEqual(["fn-0", "onRetry", "fn-1"]);
	});

	// 7. onRetry receives correct attempt number
	it("passes incrementing attempt numbers to onRetry", async () => {
		const attempts: number[] = [];
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 3, backoffMs: 1 }),
				onRetry: (_desc, attempt) => attempts.push(attempt),
			}),
		);

		let callCount = 0;
		runner.step({
			description: "retried step",
			fn: async () => {
				callCount++;
				if (callCount <= 3) throw new Error("fail");
			},
		});

		await runner.run(makeCtx());

		expect(attempts).toEqual([1, 2, 3]);
	});

	// 8. Backoff applied
	it("applies linear backoff based on attempt number", async () => {
		const sleepSpy = vi.spyOn(globalThis, "setTimeout");
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 3, backoffMs: 100 }),
			}),
		);

		runner.step({
			description: "backoff step",
			fn: async () => {
				throw new Error("fail");
			},
		});

		await runner.run(makeCtx());

		const sleepCalls = sleepSpy.mock.calls
			.filter(([, ms]) => typeof ms === "number" && ms >= 100)
			.map(([, ms]) => ms);

		expect(sleepCalls).toEqual([100, 200, 300]);
		sleepSpy.mockRestore();
	});

	// 9. Step-level onError overrides runner
	it("uses step-level onError instead of runner-level when step defines it", async () => {
		const runnerOnError = vi.fn<() => Action>(() => ({ action: "abort" }));
		const runner = createRunner(makeConfig({ onError: runnerOnError }));

		runner.step({
			description: "step with override",
			fn: async () => {
				throw new Error("error");
			},
			onError: () => ({ action: "fail" }),
		});

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("completed");
		expect(result.steps[0].status).toBe("failed");
		expect(runnerOnError).not.toHaveBeenCalled();
	});

	// 10. Step onError returns null, falls through
	it("falls through to runner-level onError when step onError returns null", async () => {
		const runnerOnError = vi.fn<() => Action>(() => ({ action: "fail" }));
		const runner = createRunner(makeConfig({ onError: runnerOnError }));

		runner.step({
			description: "step with null override",
			fn: async () => {
				throw new Error("error");
			},
			onError: () => null,
		});

		const result = await runner.run(makeCtx());

		expect(result.steps[0].status).toBe("failed");
		expect(runnerOnError).toHaveBeenCalledOnce();
	});

	// 11. Both onError return null → crashed
	it("crashes when both step and runner onError return null", async () => {
		const runner = createRunner(makeConfig({ onError: () => null }));

		runner.step({
			description: "unrecognised step",
			fn: async () => {
				throw new Error("unknown error");
			},
			onError: () => null,
		});

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("crashed");
		expect(result.error).toBeDefined();
		expect(result.error?.message).toContain("unrecognised step");
	});

	// 12. Multiple steps, one abort
	it("marks remaining steps as skipped when a middle step aborts", async () => {
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "abort" }),
			}),
		);

		runner
			.step({ description: "step 1", fn: async () => {} })
			.step({
				description: "step 2",
				fn: async () => {
					throw new Error("fatal");
				},
			})
			.step({ description: "step 3", fn: async () => {} });

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("aborted");
		expect(result.steps.map((s) => s.status)).toEqual(["success", "failed", "skipped"]);
	});

	// 13. Step-level onRetry overrides runner
	it("calls step-level onRetry instead of runner-level when step defines it", async () => {
		const runnerOnRetry = vi.fn();
		let callCount = 0;
		const stepOnRetry = vi.fn();

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 1, backoffMs: 1 }),
				onRetry: runnerOnRetry,
			}),
		);

		runner.step({
			description: "step with onRetry",
			fn: async () => {
				callCount++;
				if (callCount < 2) throw new Error("fail");
			},
			onRetry: stepOnRetry,
		});

		await runner.run(makeCtx());

		expect(stepOnRetry).toHaveBeenCalledOnce();
		expect(runnerOnRetry).not.toHaveBeenCalled();
	});

	// 14. Step-level onRetry calls defaultHandler
	it("fires runner-level onRetry when step onRetry calls defaultHandler", async () => {
		const runnerOnRetry = vi.fn();
		let callCount = 0;

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 1, backoffMs: 1 }),
				onRetry: runnerOnRetry,
			}),
		);

		runner.step({
			description: "step delegates",
			fn: async () => {
				callCount++;
				if (callCount < 2) throw new Error("fail");
			},
			onRetry: (attempt, _ctx, defaultHandler) => {
				defaultHandler(attempt);
			},
		});

		await runner.run(makeCtx());

		expect(runnerOnRetry).toHaveBeenCalledOnce();
	});

	// 15. Step-level onRetry ignores defaultHandler
	it("does not fire runner-level onRetry when step onRetry ignores defaultHandler", async () => {
		const runnerOnRetry = vi.fn();
		let callCount = 0;

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 1, backoffMs: 1 }),
				onRetry: runnerOnRetry,
			}),
		);

		runner.step({
			description: "step ignores default",
			fn: async () => {
				callCount++;
				if (callCount < 2) throw new Error("fail");
			},
			onRetry: () => {
				// intentionally not calling defaultHandler
			},
		});

		await runner.run(makeCtx());

		expect(runnerOnRetry).not.toHaveBeenCalled();
	});

	// 16. Step-level onStepFail overrides runner
	it("calls step-level onStepFail instead of runner-level when step defines it", async () => {
		const runnerOnStepFail = vi.fn();
		const stepOnStepFail = vi.fn();

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "fail" }),
				onStepFail: runnerOnStepFail,
			}),
		);

		runner.step({
			description: "step with onStepFail",
			fn: async () => {
				throw new Error("fail");
			},
			onStepFail: stepOnStepFail,
		});

		await runner.run(makeCtx());

		expect(stepOnStepFail).toHaveBeenCalledOnce();
		expect(runnerOnStepFail).not.toHaveBeenCalled();
	});

	// 17. Step-level onStepFail calls defaultHandler
	it("fires runner-level onStepFail when step onStepFail calls defaultHandler", async () => {
		const runnerOnStepFail = vi.fn();

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "fail" }),
				onStepFail: runnerOnStepFail,
			}),
		);

		runner.step({
			description: "step delegates fail",
			fn: async () => {
				throw new Error("fail");
			},
			onStepFail: (error, _ctx, defaultHandler) => {
				defaultHandler(error);
			},
		});

		await runner.run(makeCtx());

		expect(runnerOnStepFail).toHaveBeenCalledOnce();
	});

	// 18. Step-level onAbort overrides runner
	it("calls step-level onAbort instead of runner-level when step defines it", async () => {
		const runnerOnAbort = vi.fn();
		const stepOnAbort = vi.fn();

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "abort" }),
				onAbort: runnerOnAbort,
			}),
		);

		runner.step({
			description: "step with onAbort",
			fn: async () => {
				throw new Error("fatal");
			},
			onAbort: stepOnAbort,
		});

		await runner.run(makeCtx());

		expect(stepOnAbort).toHaveBeenCalledOnce();
		expect(runnerOnAbort).not.toHaveBeenCalled();
	});

	// 19. Step-level onAbort calls defaultHandler
	it("fires runner-level onAbort when step onAbort calls defaultHandler", async () => {
		const runnerOnAbort = vi.fn();

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "abort" }),
				onAbort: runnerOnAbort,
			}),
		);

		runner.step({
			description: "step delegates abort",
			fn: async () => {
				throw new Error("fatal");
			},
			onAbort: (error, _ctx, defaultHandler) => {
				defaultHandler(error);
			},
		});

		await runner.run(makeCtx());

		expect(runnerOnAbort).toHaveBeenCalledOnce();
	});

	// 20. No step-level handler — runner-level fires automatically
	it("fires runner-level handlers automatically when no step-level handlers defined", async () => {
		const onStepFail = vi.fn();
		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "fail" }),
				onStepFail,
			}),
		);

		runner.step({
			description: "no overrides",
			fn: async () => {
				throw new Error("fail");
			},
		});

		await runner.run(makeCtx());

		expect(onStepFail).toHaveBeenCalledWith("no overrides", expect.any(Error), expect.any(Object));
	});

	// 21. Context passed to fn
	it("passes page and data from run(ctx) to step fn", async () => {
		const mockPage = { locator: vi.fn() };
		const ctx = makeCtx(mockPage);
		ctx.data.set("initial", true);

		let receivedCtx: StepContext | undefined;
		const runner = createRunner(makeConfig());

		runner.step({
			description: "ctx step",
			fn: async (c) => {
				receivedCtx = c;
			},
		});

		await runner.run(ctx);

		expect(receivedCtx?.page).toBe(mockPage);
		expect(receivedCtx?.data.get("initial")).toBe(true);
	});

	// 22. Data persists across steps
	it("shares data across steps via the same context", async () => {
		let step2Value: unknown;
		const runner = createRunner(makeConfig());

		runner
			.step({
				description: "set data",
				fn: async ({ data }) => {
					data.set("key", "value");
				},
			})
			.step({
				description: "read data",
				fn: async ({ data }) => {
					step2Value = data.get("key");
				},
			});

		await runner.run(makeCtx());

		expect(step2Value).toBe("value");
	});

	// 23. Context passed to onError
	it("passes the same ctx to onError", async () => {
		let receivedCtx: StepContext | undefined;
		const runner = createRunner(
			makeConfig({
				onError: (_error, ctx) => {
					receivedCtx = ctx;
					return { action: "fail" };
				},
			}),
		);

		const ctx = makeCtx({ myPage: true });
		runner.step({
			description: "error ctx",
			fn: async () => {
				throw new Error("fail");
			},
		});

		await runner.run(ctx);

		expect(receivedCtx).toBe(ctx);
	});

	// 24. Context passed to runner-level onRetry
	it("passes ctx to runner-level onRetry", async () => {
		let receivedCtx: StepContext | undefined;
		let callCount = 0;

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "retry", maxRetries: 1, backoffMs: 1 }),
				onRetry: (_desc, _attempt, ctx) => {
					receivedCtx = ctx;
				},
			}),
		);

		const ctx = makeCtx({ myPage: true });
		runner.step({
			description: "retry ctx",
			fn: async () => {
				callCount++;
				if (callCount < 2) throw new Error("fail");
			},
		});

		await runner.run(ctx);

		expect(receivedCtx).toBe(ctx);
	});

	// 25. Context passed to step-level onAbort
	it("passes ctx to step-level onAbort with page and data", async () => {
		let receivedCtx: StepContext | undefined;
		const mockPage = { screenshot: vi.fn() };

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "abort" }),
			}),
		);

		const ctx = makeCtx(mockPage);
		ctx.data.set("tenantId", "t-123");

		runner.step({
			description: "abort ctx",
			fn: async () => {
				throw new Error("fatal");
			},
			onAbort: (_error, c) => {
				receivedCtx = c;
			},
		});

		await runner.run(ctx);

		expect(receivedCtx).toBe(ctx);
		expect(receivedCtx?.page).toBe(mockPage);
		expect(receivedCtx?.data.get("tenantId")).toBe("t-123");
	});

	// 26. Data mutations in onAbort visible
	it("makes data mutations from step onAbort visible to runner-level onAbort", async () => {
		let runnerSawValue: unknown;

		const runner = createRunner(
			makeConfig({
				onError: () => ({ action: "abort" }),
				onAbort: (_desc, _error, ctx) => {
					runnerSawValue = ctx.data.get("abortReason");
				},
			}),
		);

		runner.step({
			description: "mutate on abort",
			fn: async () => {
				throw new Error("fatal");
			},
			onAbort: (_error, ctx, defaultHandler) => {
				ctx.data.set("abortReason", "credentials_expired");
				defaultHandler(_error);
			},
		});

		await runner.run(makeCtx());

		expect(runnerSawValue).toBe("credentials_expired");
	});

	// 27. Unrecognised error → crashed
	it("crashes with error message containing step description when error is unrecognised", async () => {
		const runner = createRunner(makeConfig({ onError: () => null }));

		runner.step({
			description: "mystery step",
			fn: async () => {
				throw new Error("something weird");
			},
		});

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("crashed");
		expect(result.error?.message).toContain("mystery step");
		expect(result.error?.message).toContain("something weird");
	});

	// 28. Crashed preserves partial results
	it("preserves completed step results when a later step crashes", async () => {
		const runner = createRunner(makeConfig({ onError: () => null }));

		runner
			.step({ description: "step 1", fn: async () => {} })
			.step({
				description: "step 2",
				fn: async () => {
					throw new Error("unrecognised");
				},
			})
			.step({ description: "step 3", fn: async () => {} });

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("crashed");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]).toEqual({ description: "step 1", status: "success" });
	});

	// 29. run() always resolves
	it("always resolves and never rejects, even on crash", async () => {
		const runner = createRunner(makeConfig({ onError: () => null }));

		runner.step({
			description: "crash step",
			fn: async () => {
				throw new Error("boom");
			},
		});

		// If run() rejected, this would throw and fail the test
		const result = await runner.run(makeCtx());

		expect(result).toBeDefined();
		expect(result.status).toBe("crashed");
	});

	// 30. Crashed includes the error
	it("includes the unrecognised error in the crashed result", async () => {
		const runner = createRunner(makeConfig({ onError: () => null }));

		runner.step({
			description: "crash step",
			fn: async () => {
				throw new Error("original boom");
			},
		});

		const result = await runner.run(makeCtx());

		expect(result.status).toBe("crashed");
		expect(result.error).toBeInstanceOf(Error);
		expect(result.error?.message).toContain("original boom");
	});
});
