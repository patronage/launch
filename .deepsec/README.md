# Launch security review

DeepSec 2.3.10 supplies an on-demand source-security review alongside `pnpm verify`. A candidate scan is not an AI investigation or a security pass. The scanner has its own exact dependency pin and lockfile; it is not installed into the apps or run during deployment.

## Local candidate scan

Requires Node 24, pnpm 12, Git, tar and a running Docker-compatible engine. From the repository root:

```sh
pnpm security:scan
# Or select an existing committed revision:
pnpm security:scan <commit>
```

The command archives HEAD (or the selected commit), verifies the extracted paths and Git blob hashes, builds the digest-pinned scanner image, inspects its container settings, and runs DeepSec's deterministic matchers. A temporary bare Git repository disables `export-ignore` and `export-subst` for this archive: package release rules must not omit tracked files or change their bytes in a security snapshot. This does not change the live checkout's attributes, index or files. The image build downloads pinned dependencies; the scan itself has no network or model credentials. The container is non-root, has a read-only filesystem and source mount, drops capabilities, and persists only its data directory. The live checkout, home directory, agent sessions and Docker socket are not mounted.

The selected commit identifies the source snapshot. The wrapper, matchers, image build inputs and review context come from the current `.deepsec/` checkout. Preserve the image ID and context hashes below when comparing scans; selecting an older source commit does not select its older scanner configuration.

Every invocation creates `.deepsec/runs/<timestamp>/` with:

- `manifest.json`, `source.tar` and `source/`: the exact reviewed commit and files;
- `image-id` and `container.json`: the scanner image and inspected containment;
- `review-context.json`: hashes of the project context and priority configuration copied into `data/launch/INFO.md` and `data/launch/config.json`, where DeepSec reads them;
- `scan.log`, `result.json` and `data/`: candidate counts, phase status and resumable DeepSec records.

These files are ignored by Git. Uncommitted edits, including newly added integration files, are excluded. Commit the intended source revision before reviewing it. Symlinks must stay inside the snapshot; submodules, LFS pointers, any remaining archive substitutions/omissions and common credential filenames fail closed. This filename check is not a secret scanner: review tracked content before sending a snapshot to any model provider, even though Launch's source is public.

Run `pnpm security:test` for the snapshot-boundary regressions. Those tests also run in `pnpm verify`; Docker and model access are not required for them.

## Model-backed review is disabled

The subscription runner is unavailable until its proxy enforces the TLS upstream-name boundary. The current CONNECT allowlist checks the requested tunnel destination but does not verify the TLS server name or HTTP authority inside that tunnel. An allowed hostname can share an IP with another origin, so the allowlist does not restrict encrypted traffic to the intended OpenAI services. The retained runner code is not an approved route for model access.

`security:subscription` rejects `start`, `login`, `status`, `process`, `revalidate` and `export` before reading run state, creating a snapshot, invoking Docker or accessing authentication. Candidate discovery through `pnpm security:scan` remains available; its scan container has no network or model credentials.

Only cleanup of an existing subscription runner remains supported:

```sh
pnpm security:subscription stop <run-directory>
```

Use the existing run directory under `.deepsec/runs/`. `stop` attempts logout and removes the runner, proxy and their networks even if logout fails. Removing the runner deletes its tmpfs login and session state; findings and DeepSec data remain in the run's `data/` directory. Check any cleanup errors before considering the session removed.

Launch's tracked source is public, but public source does not make scanner execution trusted. Do not bypass the disabled route, copy host authentication into a runner, or run agent-backed `init`, `setup`, `process`, `revalidate` or `triage` against the host checkout. Default `init`/`setup` can start agents automatically. Re-enabling model-backed review requires a repaired and independently verified egress boundary.

## Coverage and limits

[INFO.md](INFO.md) describes Launch's auth boundaries and intended public surfaces, including Composer distribution, Fleet reporting and package installation outside Launch. Keep it current when those boundaries change. The Launch plugin adds first-party PHP and shell entry points that the built-in root technology detection missed, plus exact-path entry points for `wordpress-shared/plugin-release/release.ts` and `apps/docs-site/scripts/build-output.mjs`. The PHP pattern covers Fleet and the moved Headless Revalidate implementation as well as the app's loader. These candidates request investigation; they are not vulnerability findings. Inspect coverage before adding further matchers.

Composer metadata and deployment configuration are supporting review context: each package's `composer.json` and `.gitattributes`, the public index and redirect rules, the headless `composer.json`, build/include files and local Docker mounts. Priority paths draw attention to those files but do not override DeepSec's own file filters or create candidates. Compare scan records with these paths and state exclusions in the review report. The package-install documentation and ADR 0017 describe intended behavior; they are not executable entry points. Model-backed processing is disabled; candidate discovery cannot establish vulnerability findings.

A whole-repository snapshot includes our PHP, TypeScript, JavaScript and shell source. DeepSec applies its own file/technology filters, so snapshot inclusion does not mean every file receives AI review. Record missed surfaces and review them explicitly. Installed WordPress/npm vendor code is absent by design. Dependency advisories, runtime deployments and Cloudflare Access policy state, full Git history, and dynamic exploit proofs need separate checks. `pnpm verify` remains the local correctness gate; DeepSec does not validate everything.

DeepSec's investigation prompt also excludes non-production code. A selected setup script or sample can be read and still excluded from findings. Inspect each analysis history's `refusal.skipped` field, record the reason, and review operational or local-development risks separately. Do not count an `analyzed` status alone as completed coverage.

Upstream: [DeepSec](https://github.com/vercel-labs/deepsec).
