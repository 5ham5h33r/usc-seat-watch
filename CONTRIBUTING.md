# Contributing

Use Node.js 22 or later and Git:

```sh
npm ci
npm run check
```

Create a branch for one feature or fix, using names such as
`feature/course-search` or `fix/session-recovery`. Keep commits focused and
describe the behavior they change. Open a pull request against `main` with
the problem, resulting behavior, and validation. Merge after the checks pass,
then delete the merged feature branch.

Use simulated USC responses for tests. Do not submit live registrations,
change someone's Course Bin, force a logout, or trigger MFA to test a patch.
Preserve the isolation journal and uncertain-operation claims across errors,
Stop, and worker restarts. Changes to checkout handling need tests for stale
data, cancellation, unrelated selections, and ambiguous server responses.

Keep credentials and private registration data out of issues, fixtures, and
logs. Document changes to permissions or stored data in `docs/privacy.md`.
Use ASCII apostrophes in authored text.

## Release

Update the version in `extension/manifest.json`, `package.json`, and
`package-lock.json`, then update `CHANGELOG.md`. Merge the release changes
through a pull request. From a clean `main` checkout, run:

```sh
npm ci
npm run check
npm run package
```

The package command archives the committed `extension` directory, adds the
license, and writes a ZIP and SHA-256 checksum to `dist/`. Create a GitHub
release for the matching `vX.Y.Z` tag and attach both files. Verify the
published asset and link to the installation instructions in the release notes.
