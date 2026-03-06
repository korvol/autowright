import type {
	Action,
	RunResult,
	Runner,
	RunnerConfig,
	StepContext,
	StepDefinition,
	StepResult,
} from "./types.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the action for a failed step. Step-level `onError` takes priority.
 * If it returns `null`, falls through to the runner-level `onError`.
 * If both return `null`, returns `null` — the caller treats this as a crash.
 */
function resolveAction<TPage>(
	config: RunnerConfig<TPage>,
	step: StepDefinition<TPage>,
	error: Error,
	ctx: StepContext<TPage>,
): Action | null {
	if (step.onError) {
		const action = step.onError(error, ctx);
		if (action !== null) return action;
	}
	return config.onError(error, ctx);
}

/**
 * Fire the onRetry event. Builds a `defaultHandler` that calls the runner-level handler.
 * If the step defines its own `onRetry`, it receives the `defaultHandler` and decides
 * whether to call it. If no step-level handler, the runner-level fires automatically.
 */
function fireOnRetry<TPage>(
	config: RunnerConfig<TPage>,
	step: StepDefinition<TPage>,
	attempt: number,
	ctx: StepContext<TPage>,
): void {
	const defaultHandler = (a: number) => config.onRetry?.(step.description, a, ctx);
	if (step.onRetry) {
		step.onRetry(attempt, ctx, defaultHandler);
	} else {
		defaultHandler(attempt);
	}
}

/** Fire the onStepFail event. Same delegation pattern as {@link fireOnRetry}. */
function fireOnStepFail<TPage>(
	config: RunnerConfig<TPage>,
	step: StepDefinition<TPage>,
	error: Error,
	ctx: StepContext<TPage>,
): void {
	const defaultHandler = (e: Error) => config.onStepFail?.(step.description, e, ctx);
	if (step.onStepFail) {
		step.onStepFail(error, ctx, defaultHandler);
	} else {
		defaultHandler(error);
	}
}

/** Fire the onAbort event. Same delegation pattern as {@link fireOnRetry}. */
function fireOnAbort<TPage>(
	config: RunnerConfig<TPage>,
	step: StepDefinition<TPage>,
	error: Error,
	ctx: StepContext<TPage>,
): void {
	const defaultHandler = (e: Error) => config.onAbort?.(step.description, e, ctx);
	if (step.onAbort) {
		step.onAbort(error, ctx, defaultHandler);
	} else {
		defaultHandler(error);
	}
}

/**
 * Internal discriminator returned by `executeStep`. Carries both the public `StepResult`
 * and the action that produced it, so `runSteps` can decide whether to abort without
 * re-calling `resolveAction` (which could return a different result if ctx.data was mutated).
 */
type ExecuteResult = {
	result: StepResult;
	action: "success" | "fail" | "abort";
};

/**
 * Execute a single step with retry logic.
 *
 * Flow:
 *   1. Run the step function.
 *   2. On success → return immediately.
 *   3. On error → resolve action via step-level then runner-level `onError`.
 *   4. If action is `null` → throw (escapes to `runSteps` → status: 'crashed').
 *   5. If action is `abort` → fire onAbort, return with action: 'abort'.
 *   6. If action is `fail` → fire onStepFail, return with action: 'fail'.
 *   7. If action is `retry` → check attempt count, fire onRetry, wait, loop.
 *      When retries are exhausted → fire onStepFail, return with action: 'fail'.
 */
async function executeStep<TPage>(
	config: RunnerConfig<TPage>,
	step: StepDefinition<TPage>,
	ctx: StepContext<TPage>,
): Promise<ExecuteResult> {
	let attempt = 0;

	while (true) {
		try {
			await step.fn(ctx);
			return {
				result: { description: step.description, status: "success" },
				action: "success",
			};
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			const action = resolveAction(config, step, error, ctx);

			// Unrecognised error — neither handler knew what to do.
			// Throw to escape to runSteps, which catches and returns status: 'crashed'.
			if (action === null) {
				throw new Error(`Unrecognised error in step "${step.description}": ${error.message}`);
			}

			if (action.action === "abort") {
				fireOnAbort(config, step, error, ctx);
				return {
					result: { description: step.description, status: "failed", error },
					action: "abort",
				};
			}

			if (action.action === "fail") {
				fireOnStepFail(config, step, error, ctx);
				return {
					result: { description: step.description, status: "failed", error },
					action: "fail",
				};
			}

			if (action.action === "retry") {
				if (attempt >= action.maxRetries) {
					// Retries exhausted — treat as a final failure.
					fireOnStepFail(config, step, error, ctx);
					return {
						result: { description: step.description, status: "failed", error },
						action: "fail",
					};
				}
				attempt++;
				fireOnRetry(config, step, attempt, ctx); // fires BEFORE the wait
				await sleep(action.backoffMs * attempt); // linear backoff
			}
		}
	}
}

/**
 * Execute all steps sequentially. On abort, remaining steps are marked 'skipped'.
 * Catches unrecognised errors (thrown by `executeStep`) and returns status: 'crashed'
 * with partial results preserved.
 */
async function runSteps<TPage>(
	config: RunnerConfig<TPage>,
	steps: StepDefinition<TPage>[],
	ctx: StepContext<TPage>,
): Promise<RunResult> {
	const results: StepResult[] = [];

	try {
		for (let i = 0; i < steps.length; i++) {
			const { result, action } = await executeStep(config, steps[i], ctx);
			results.push(result);

			if (action === "abort") {
				// Mark all remaining steps as skipped
				for (let j = i + 1; j < steps.length; j++) {
					results.push({ description: steps[j].description, status: "skipped" });
				}
				return { status: "aborted", steps: results };
			}
		}

		return { status: "completed", steps: results };
	} catch (err) {
		// Unrecognised error from executeStep. Partial results are preserved in `results`.
		const error = err instanceof Error ? err : new Error(String(err));
		return { status: "crashed", steps: results, error };
	}
}

/**
 * Create a runner instance. Add steps with `.step()`, execute with `.run()`.
 *
 * @param config - Runner-level error handling and event hooks.
 * @returns A chainable runner. Call `.step()` to add steps, `.run(ctx)` to execute.
 *
 * @example
 * ```typescript
 * const result = await createRunner<Page>({
 *   onError: (error) => {
 *     if (error.message.includes('timeout'))
 *       return { action: 'retry', maxRetries: 3, backoffMs: 1000 }
 *     return { action: 'fail' }
 *   },
 * })
 *   .step({ description: 'login', fn: loginFn })
 *   .step({ description: 'scrape', fn: scrapeFn })
 *   .run({ page, data: new Map() })
 * ```
 */
export function createRunner<TPage>(config: RunnerConfig<TPage>): Runner<TPage> {
	const steps: StepDefinition<TPage>[] = [];

	const runner: Runner<TPage> = {
		step(definition: StepDefinition<TPage>): Runner<TPage> {
			steps.push(definition);
			return runner;
		},

		run(ctx: StepContext<TPage>): Promise<RunResult> {
			return runSteps(config, steps, ctx);
		},
	};

	return runner;
}
