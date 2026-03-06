# Autowright

A framework for building resilient [Playwright](https://playwright.dev/) scripts.

Autowright provides the **decision loop** for browser automation: run a step, catch the error, classify it, decide what to do. The framework ships no error types, no built-in classifiers, no opinions about what errors mean. Every website is different. You bring the classification logic — Autowright provides the structure.

> **Early stage.** This project is under active development. The API is not stable yet.

## Concepts

**Runner** — The execution loop. Runs steps in sequence, catches errors, calls the classifier, resolves the response config, handles retries.

**Step** — A unit of work. A function that does something with Playwright, plus an optional error handler.

**Classifier** — A user-provided function that takes a raw error and returns a classification string. The framework doesn't define what strings are valid — you decide what makes sense for your scripts.

**ResilienceConfig** — What to do when an error occurs: retry or not, how many times, with what backoff.

## How It Works

```
execute step -> catch error -> classify -> resolve config -> act -> next step or abort
```

The Runner catches errors from your steps, passes them through your classifier, and resolves a response: retry with backoff, fail the step and continue, or abort the entire run. Steps can override the default behavior for specific error types.

## Status

Building the core Runner and interfaces. Not published to npm yet.

## License

[Apache License 2.0](LICENSE)
