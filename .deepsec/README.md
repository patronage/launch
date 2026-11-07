# Launch security review

DeepSec 2.3.10 supplies an on-demand source-security review alongside `pnpm verify`. A candidate scan is not an AI investigation or a security pass. The scanner has its own exact dependency pin and lockfile; it is not installed into the apps or run during deployment.

## Handling results

Follow [Handling security findings](../docs/agents/security-findings.md) for every review. Keep findings, reproductions, exports and detailed reviewer reports in ignored `.deepsec/runs/` storage and report them to Cameron in this chat. Confirm evidence is ignored and untracked before committing or uploading artifacts. Publication of findings or revealing patches requires approval of the specific material and destination, even after a fix is prepared. Aggregate candidate counts and coverage limits can be reported without publishing vulnerability details.

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

## Model-backed review is not available

This workspace ships no model-backed runner. A runner needs an egress boundary that is enforced and independently verified before it holds a model login and a source snapshot; add one in its own reviewed change. Until then, candidate discovery through `pnpm security:scan` is the only supported workflow, and its container has no network or model credentials.

Launch's tracked source is public, but public source does not make scanner execution trusted. Do not copy host authentication into a container or run agent-backed DeepSec `init`, `setup`, `process`, `revalidate` or `triage` against the host checkout; default `init`/`setup` can start agents automatically.

If an earlier local setup left a runner behind, remove its containers and networks, all named `launch-deepsec-<id>…` as listed in that run's `subscription.json`:

```sh
docker ps -a --filter name=launch-deepsec- --format '{{.Names}}' | xargs -r docker rm --force
docker network ls --filter name=launch-deepsec- --format '{{.Name}}' | xargs -r docker network rm
```

Removing a runner deletes its tmpfs login and session state; DeepSec data stays in the run's `data/` directory.

## Coverage and limits

[INFO.md](INFO.md) describes Launch's auth boundaries and intended public surfaces, including Composer distribution, Fleet reporting and package installation outside Launch. Keep it current when those boundaries change. The Launch plugin adds first-party PHP and shell entry points that the built-in root technology detection missed, plus exact-path entry points for `wordpress-shared/plugin-release/release.ts` and `apps/docs-site/scripts/build-output.mjs`. The PHP pattern covers Fleet and the moved Headless Revalidate implementation as well as the app's loader. These candidates request investigation; they are not vulnerability findings. Inspect coverage before adding further matchers.

Composer metadata and deployment configuration are supporting review context: each package's `composer.json` and `.gitattributes`, the public index and redirect rules, the headless `composer.json`, build/include files and local Docker mounts. Priority paths draw attention to those files but do not override DeepSec's own file filters or create candidates. Compare scan records with these paths and state exclusions in the review report. The package-install documentation and ADR 0017 describe intended behavior; they are not executable entry points. Candidate discovery alone cannot establish vulnerability findings.

A whole-repository snapshot includes our PHP, TypeScript, JavaScript and shell source. DeepSec applies its own file/technology filters, so snapshot inclusion does not mean every file receives AI review. Record missed surfaces and review them explicitly. Installed WordPress/npm vendor code is absent by design. Dependency advisories, runtime deployments and Cloudflare Access policy state, full Git history, and dynamic exploit proofs need separate checks. `pnpm verify` remains the local correctness gate; DeepSec does not validate everything.

DeepSec's investigation prompt also excludes non-production code. A selected setup script or sample can be read and still excluded from findings. Inspect each analysis history's `refusal.skipped` field, record the reason, and review operational or local-development risks separately. Do not count an `analyzed` status alone as completed coverage.

Upstream: [DeepSec](https://github.com/vercel-labs/deepsec).
