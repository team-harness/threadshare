---
name: "threadshare-stable-release"
description: "Validate, publish, and recover a Threadshare stable npm release through the pinned GitHub Release workflow."
---
## Procedure

1. Read the repository release contract in `AGENTS.md` and inspect the current
   `publish-npm.yml` workflow before changing versions.

2. Verify npm credentials against `https://registry.npmjs.org/`. Do not infer
   npmjs authentication failure from a mirrored default registry.

3. Set one unused, unprefixed stable version consistently in `package.json`
   and the lockfile root. Keep platform dependencies out of the source
   manifest; release staging injects them.

4. Run the complete pinned release verification suite. Require Rust formatting,
   Clippy, Rust and Node tests, CLI/API/Viewer checks, release allowlists, package
   size limits, and dry-run package inspection to pass.

5. Commit and push the exact candidate to `main`. Confirm that no earlier stable
   release workflow is active, cancelled, or failed, then create the GitHub
   Release from that exact commit.

6. Require the workflow to produce the four macOS/Linux Engine packages,
   signatures or notarization, SBOMs, six-target consumer smoke results, and the
   root package last. Windows remains core-only until separately approved.

7. Verify npm `latest`, provenance, and a clean temporary installation from the
   registry. Do not treat a successful GitHub job alone as registry acceptance.

## Recovery

- When none of the target versions reached npm, fix the source and recreate only
  the unpublished Release and tag.
- When publication succeeded and only registry confirmation failed transiently,
  rerun the original workflow run.
- Once any target package is published, never move its tag or rebuild that
  version with changed source. Fix the problem under a new version.
- A cancelled release is incomplete and must be resolved before publishing a
  higher version.

## Guardrails

- Stable packages are published only by the GitHub Release workflow.
- Never run local stable `npm publish`.
- Never expose npm tokens, signing credentials, or revoke capabilities.
- The one-time `0.0.0-bootstrap.0` exception requires explicit owner approval
  and must never be repeated.
