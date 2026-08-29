# LocalWorkspaceBridge Benchmark

This directory contains a reproducible local benchmark for the public LocalWorkspaceBridge codebase.

The benchmark intentionally measures host-side behavior that can be reproduced without a paid model API:

- MCP tool-schema size for `minimal`, `standard`, and `full` modes;
- a shared direct-agent workflow (`read` → `edit` → `show_changes` plus a blocked sensitive-path read);
- repository inventory and search latency on a generated source tree;
- verification that the advertised tool surface matches the direct-agent architecture.

Run:

```bash
npm run benchmark:quick
npm run benchmark
```

Results are printed as JSON and are not committed automatically, so machine-specific paths, timings, and transient artifacts do not enter the repository.

`model-runner.mjs` defines an optional adapter boundary for future fixed-model Agent evaluation. Model-dependent Pass@1, repeated-run reliability, token usage, and cost should only be reported when a fixed external model is actually configured and executed.
