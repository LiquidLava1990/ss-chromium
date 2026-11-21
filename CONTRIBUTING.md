# Contributing

Bug reports, fixes and improvements are welcome.

- **Bugs**: open an issue with `ss-chromium doctor` output, your browser and operating system,
  and steps to reproduce. For a security problem, follow [SECURITY.md](SECURITY.md) instead.
- **Larger changes**: open an issue first. SS Chromium gives AI apps control of a signed-in
  browser, so changes to what they can reach, to pairing or to the protocol get a careful look.
- **Out of scope**: CAPTCHA solving, bot-detection evasion and fingerprint spoofing. Such
  changes are not accepted.

## Setting up

Node.js 24+ and pnpm (`corepack enable`):

```sh
pnpm install
pnpm --filter @browsermcp/mcp exec playwright-core install chromium  # once, for the server's tests
pnpm build
```

## Checks (what CI runs)

```sh
pnpm lint
pnpm format        # pnpm format:fix fixes it
pnpm typecheck
pnpm test
pnpm build
pnpm smoke                       # extension + server in headless Chromium
pnpm --filter ss-chromium e2e    # the packaged runtime, end to end
```

Tests use random ports and temporary state directories, so they never touch your own
installation.

## Pull requests

- One change per pull request, titled `fix: …`, `feat: …` and so on.
- Add or update tests next to the code. Fix bugs with a test that fails without the fix.
- Protocol changes go into both sides at once: the daemon (`packages/mcp/src/relay/`) and
  `packages/extension-core`. Nothing may send data anywhere on its own.

## License

By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE). You keep the copyright to what you wrote.
