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

type ExecuteResult = {
	result: StepResult;
	action: "success" | "fail" | "abort";
};

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
					fireOnStepFail(config, step, error, ctx);
					return {
						result: { description: step.description, status: "failed", error },
						action: "fail",
					};
				}
				attempt++;
				fireOnRetry(config, step, attempt, ctx);
				await sleep(action.backoffMs * attempt);
			}
		}
	}
}

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
				for (let j = i + 1; j < steps.length; j++) {
					results.push({ description: steps[j].description, status: "skipped" });
				}
				return { status: "aborted", steps: results };
			}
		}

		return { status: "completed", steps: results };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		return { status: "crashed", steps: results, error };
	}
}

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
