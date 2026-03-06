/**
 * The response from an `onError` handler. Tells the runner what to do with a failed step.
 *
 * - `retry` — re-run the step up to `maxRetries` times with linear backoff (`backoffMs * attempt`).
 * - `fail` — mark the step as failed and continue to the next step.
 * - `abort` — mark the step as failed, skip all remaining steps, fire `onAbort`.
 */
export type Action =
	| { action: "retry"; maxRetries: number; backoffMs: number }
	| { action: "fail" }
	| { action: "abort" };

/**
 * Shared context passed to every step and event handler.
 *
 * @typeParam TPage - The page type (e.g. Playwright's `Page`). Defaults to `unknown`.
 *
 * @property page - The browser page instance. Generic so the framework doesn't depend on Playwright.
 * @property data - A shared map for passing data between steps. Step 1 can `data.set('key', value)`,
 *   step 2 can `data.get('key')`. Same instance across all steps and event handlers.
 */
export type StepContext<TPage = unknown> = {
	page: TPage;
	data: Map<string, unknown>;
};

/**
 * Defines a single step in the runner.
 *
 * @property description - Human-readable label. Used in error messages, passed to runner-level event handlers.
 * @property fn - The step function. Receives the shared context. Throw to trigger error handling.
 * @property onError - Step-level error handler. Takes priority over the runner-level `onError`.
 *   Return an {@link Action} to handle the error, or `null` to fall through to the runner-level handler.
 * @property onRetry - Fires before each retry attempt, before the backoff wait.
 *   Receives a `defaultHandler` that calls the runner-level `onRetry`. Call it, ignore it, or call it conditionally.
 * @property onStepFail - Fires when the step has failed for good (no retry, or retries exhausted).
 *   Receives a `defaultHandler` that calls the runner-level `onStepFail`.
 * @property onAbort - Fires when the step triggers an abort.
 *   Receives a `defaultHandler` that calls the runner-level `onAbort`.
 */
export type StepDefinition<TPage = unknown> = {
	description: string;
	fn: (ctx: StepContext<TPage>) => Promise<unknown>;
	onError?: (error: Error, ctx: StepContext<TPage>) => Action | null;
	onRetry?: (
		attempt: number,
		ctx: StepContext<TPage>,
		defaultHandler: (attempt: number) => void,
	) => void;
	onStepFail?: (
		error: Error,
		ctx: StepContext<TPage>,
		defaultHandler: (error: Error) => void,
	) => void;
	onAbort?: (error: Error, ctx: StepContext<TPage>, defaultHandler: (error: Error) => void) => void;
};

/**
 * Configuration for the runner. Defines the default error handling and event hooks.
 *
 * @property onError - **Required.** Classifies errors and returns an {@link Action}.
 *   Return `null` if the error is unrecognised — if both step-level and runner-level return `null`,
 *   the runner crashes with `status: 'crashed'`.
 * @property onRetry - Fires before each retry attempt for any step. Receives the step `description`
 *   so you know which step is retrying.
 * @property onStepFail - Fires when any step fails for good. Receives the step `description`.
 * @property onAbort - Fires when any step triggers an abort. Receives the step `description`.
 *   This is where you put Slack alerts, DB updates, or screenshots.
 */
export type RunnerConfig<TPage = unknown> = {
	onError: (error: Error, ctx: StepContext<TPage>) => Action | null;
	onRetry?: (description: string, attempt: number, ctx: StepContext<TPage>) => void;
	onStepFail?: (description: string, error: Error, ctx: StepContext<TPage>) => void;
	onAbort?: (description: string, error: Error, ctx: StepContext<TPage>) => void;
};

export type StepStatus = "success" | "failed" | "skipped";

/**
 * The result of a single step after execution.
 *
 * @property description - The step's description label.
 * @property status - `'success'` if the step completed, `'failed'` if it threw and wasn't retried
 *   successfully, `'skipped'` if a previous step aborted.
 * @property error - The error that caused the failure. Only present when `status` is `'failed'`.
 */
export type StepResult = {
	description: string;
	status: StepStatus;
	error?: Error;
};

/**
 * The result of a full runner execution. `run()` always resolves — never rejects.
 *
 * @property status
 * - `'completed'` — all steps ran. Individual steps may have failed, but the runner handled them.
 * - `'aborted'` — a step returned `{ action: 'abort' }`. Controlled stop. Remaining steps are `'skipped'`.
 * - `'crashed'` — an error was unrecognised (both `onError` handlers returned `null`). Partial results preserved.
 * @property steps - Results for each step, in order. Includes skipped steps after an abort.
 * @property error - The unrecognised error. Only present when `status` is `'crashed'`.
 */
export type RunResult = {
	status: "completed" | "aborted" | "crashed";
	steps: StepResult[];
	error?: Error;
};

/**
 * The runner instance. Add steps with `.step()`, execute with `.run()`.
 *
 * @example
 * ```typescript
 * const result = await createRunner<Page>({ onError: classify })
 *   .step({ description: 'login', fn: loginFn })
 *   .step({ description: 'scrape', fn: scrapeFn })
 *   .run({ page, data: new Map() })
 * ```
 */
export type Runner<TPage = unknown> = {
	/** Add a step to the runner. Returns the runner for chaining. */
	step: (definition: StepDefinition<TPage>) => Runner<TPage>;
	/** Execute all steps sequentially. Always resolves, never rejects. */
	run: (ctx: StepContext<TPage>) => Promise<RunResult>;
};
