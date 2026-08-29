# Contributing

Thanks for contributing to LocalWorkspaceBridge.

## Development setup

```bash
npm install
npm run build
npm run smoke
npm run benchmark:quick
```

Use Node.js 20+ and Git. Image-tool tests also require Python 3 with PyMuPDF installed.

## Project principles

- Keep ChatGPT/model reasoning separate from the local gateway. LocalWorkspaceBridge should provide evidence and execution primitives rather than duplicate the model's planning layer.
- Preserve explicit workspace and security boundaries.
- Prefer bounded outputs over dumping whole repositories or large binary assets into model context.
- Add focused regression coverage for behavior changes.
- Do not commit local tokens, profile files, screenshots, logs, generated benchmark results, or machine-specific paths.

## Pull requests

A useful pull request should include:

- the user-visible problem being solved;
- the implementation boundary;
- tests or reproducible verification;
- any security or compatibility implications.

Before opening a pull request, run `npm run build` and `npm run smoke`.
