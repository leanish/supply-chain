Run manually on the weekly PATH with npm 11.19.1 and registry DNS:

```sh
PATH="/opt/homebrew/bin:$PATH" node packages/secure-it/test/npm-exact-smoke.ts /path/to/sc-repro /path/to/dtv-repro
```

Use the manifest/lock-only base fixtures from the Vite incident (8.3.2 locked).
The script reads only package.json, package-lock.json and workspace manifests. It
copies them into temporary directories under this worktree, runs the real shared
security materializer, prints the exact Vite/PostCSS resolution and restored
manifest, then removes those directories. It reads no tokens, invokes no model or
repository scripts, changes no git state, and publishes nothing. This exercises
both direct Vite and supply-chain's peer-only Vite layout with real npm, beyond the
network-free fake resolver regressions. Expected: Vite 8.3.3 at every planned
location, PostCSS 8.5.28 (or an aged allowed version if registry state changed), no
temporary devDependency or override, and the intended direct range restored. A
post-restore drift is an error. This is not a gate/security-policy proof; the full
tool still runs compare before publication. It intentionally needs the public npm
registry and is not part of npm run check.
