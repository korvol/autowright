export type Action =
	| { action: "retry"; maxRetries: number; backoffMs: number }
	| { action: "fail" }
	| { action: "abort" };

export type StepContext<TPage = unknown> = {
	page: TPage;
	data: Map<string, unknown>;
};

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

export type RunnerConfig<TPage = unknown> = {
	onError: (error: Error, ctx: StepContext<TPage>) => Action | null;
	onRetry?: (description: string, attempt: number, ctx: StepContext<TPage>) => void;
	onStepFail?: (description: string, error: Error, ctx: StepContext<TPage>) => void;
	onAbort?: (description: string, error: Error, ctx: StepContext<TPage>) => void;
};

export type StepStatus = "success" | "failed" | "skipped";

export type StepResult = {
	description: string;
	status: StepStatus;
	error?: Error;
};

export type RunResult = {
	status: "completed" | "aborted" | "crashed";
	steps: StepResult[];
	error?: Error;
};

export type Runner<TPage = unknown> = {
	step: (definition: StepDefinition<TPage>) => Runner<TPage>;
	run: (ctx: StepContext<TPage>) => Promise<RunResult>;
};
