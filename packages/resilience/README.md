# @autowright/resilience

Resilient execution runner for Playwright scripts. Retry on timeouts, fail gracefully on non-critical errors, abort on fatal failures — with event hooks at every level.

## Install

```bash
npm install @autowright/resilience
```

## Quick Start

```typescript
import type { Page } from 'playwright'
import { createRunner } from '@autowright/resilience'

const runner = createRunner<Page>({
  onError: (error) => {
    if (error.message.includes('credentials invalid'))
      return { action: 'abort' }
    if (error.message.includes('timeout'))
      return { action: 'retry', maxRetries: 3, backoffMs: 1000 }
    return null // unrecognised → crash
  },
  onAbort: (description, error) => {
    console.error(`aborted at "${description}": ${error.message}`)
  },
})

runner
  .step({
    description: 'login',
    fn: async ({ page, data }) => {
      await page.fill('#username', username)
      await page.fill('#password', password)
      await page.click('#submit')
      data.set('loggedInAt', Date.now())
    },
  })
  .step({
    description: 'extract data',
    fn: async ({ page, data }) => {
      await page.locator('.closing-date').click()
      data.set('closingDate', await page.locator('.closing-date').textContent())
    },
  })

const result = await runner.run({ page, data: new Map() })
// result.status: 'completed' | 'aborted' | 'crashed'
```

## Core Concept

A script is a sequence of steps. Each step is a function. When a step throws, the runner asks one question: **what should be done?**

The answer comes from `onError` — a single function that takes the raw error and returns an action:

| Action | Behavior |
|--------|----------|
| `{ action: 'retry', maxRetries, backoffMs }` | Wait, re-run the step. Linear backoff (`backoffMs * attempt`). |
| `{ action: 'fail' }` | Mark step as failed, continue to the next step. |
| `{ action: 'abort' }` | Mark step as failed, skip remaining steps. |
| `null` | Unrecognised error. Runner crashes with `status: 'crashed'`. |

## Events

Three events fire during execution. Each exists at **runner level** and **step level**.

**Runner-level** handlers receive the step `description` as the first parameter. **Step-level** handlers receive a `defaultHandler` they can call to delegate to the runner-level handler, ignore, or call conditionally.

### onRetry

Fires before each retry attempt, before the backoff wait.

```typescript
// Runner-level
onRetry: (description, attempt, ctx) => {
  console.log(`retrying "${description}", attempt ${attempt}`)
}

// Step-level — clear state before retry, then call default
onRetry: (attempt, ctx, defaultHandler) => {
  ctx.page.evaluate(() => localStorage.clear())
  defaultHandler(attempt)
}
```

### onStepFail

Fires when a step has failed for good — no retry config, or retries exhausted.

```typescript
// Runner-level
onStepFail: (description, error, ctx) => {
  console.error(`"${description}" failed: ${error.message}`)
}
```

### onAbort

Fires when `onError` returns `{ action: 'abort' }`. The script stops. Remaining steps are marked `skipped`.

```typescript
// Step-level — screenshot on abort, then call default
onAbort: (error, ctx, defaultHandler) => {
  ctx.page.screenshot({ path: 'abort.png' })
  defaultHandler(error)
}
```

## onError Resolution

1. **Step-level `onError`** runs first. If it returns an action, that's used.
2. If step-level returns `null`, **runner-level `onError`** runs.
3. If both return `null` — unrecognised error. Runner status: `crashed`.

```typescript
runner.step({
  description: 'login',
  fn: loginFn,
  onError: (error) => {
    // handle step-specific errors
    if (error.message.includes('2FA required'))
      return { action: 'abort' }
    return null // fall through to runner-level
  },
})
```

## Context

Every step receives a `StepContext<TPage>` with:

- **`page`** — your Playwright page (or any generic type)
- **`data`** — a `Map<string, unknown>` shared across all steps

```typescript
// Step 1 writes
fn: async ({ data }) => { data.set('token', 'abc') }

// Step 2 reads
fn: async ({ data }) => { console.log(data.get('token')) } // 'abc'
```

## RunResult

`run()` always resolves — never rejects. Even on crash.

```typescript
type RunResult = {
  status: 'completed' | 'aborted' | 'crashed'
  steps: StepResult[]
  error?: Error // only when status === 'crashed'
}

type StepResult = {
  description: string
  status: 'success' | 'failed' | 'skipped'
  error?: Error
}
```

## API

### `createRunner<TPage>(config: RunnerConfig<TPage>): Runner<TPage>`

Creates a runner instance.

### `runner.step(definition: StepDefinition<TPage>): Runner<TPage>`

Adds a step. Returns the runner for chaining.

### `runner.run(ctx: StepContext<TPage>): Promise<RunResult>`

Executes all steps sequentially. Always resolves.

## License

[Apache-2.0](https://github.com/korvol/autowright/blob/main/LICENSE)
