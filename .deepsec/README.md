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

## Model-backed review with a Codex subscription

The model route is `local`, the agent is Codex, and the model is explicitly `gpt-6-astra` at `xhigh`. Authentication uses a fresh ChatGPT subscription login inside a disposable local Docker runner. There are no API keys, third-party model gateways or Vercel Sandbox resources. Usage counts against the signed-in subscription's allowance; the runner does not fall back to an API provider.

```sh
pnpm security:subscription start <commit>
# The start command prints the absolute run directory. Use it below.
pnpm security:subscription login <run-directory>
pnpm security:subscription status <run-directory>
pnpm security:subscription process <run-directory>
pnpm security:subscription revalidate <run-directory>
pnpm security:subscription export <run-directory>
pnpm security:subscription stop <run-directory>
```

Complete the device-login prompt in your browser. Never copy or mount a host Codex home, auth file or existing subscription session. The runner stores the fresh login and Codex session state on tmpfs; stopping it deletes that local state. Always stop the runner when finished, including after a failed review. Findings and DeepSec state remain in the run's `data/` directory. A new runner requires a fresh login. `stop` attempts logout and removes containers/networks even if logout fails.

The runner has only an internal Docker network. A separate local CONNECT proxy permits TLS connections to exactly `auth.openai.com:443` and `chatgpt.com:443`. The proxy cannot read the encrypted model traffic and has no repository or credential mounts. It refuses other destinations; the runner has no direct outbound route. The subscription credential is transiently available inside the guest, so treat the guest as sensitive and disposable. This is not the separate API-key credential-injection topology.

DeepSec filters proxy environment variables before spawning Codex. The fixed `proxy-env.mjs` preload restores them inside each Node CLI child without modifying third-party code. The network boundary also blocks attempts to bypass the proxy. Container settings and source hashes are rechecked before every operation. Subscription status must report ChatGPT authentication before any model-backed phase; API-key sessions are refused.

The wrapper refreshes the controlled project context before each DeepSec invocation. After startup, context and file-selection writes execute inside the guest so guest-created symlinks cannot redirect host writes. Keep `INFO.md` aligned with the revision under review and cite dated platform facts that affect triage. Findings still need independent validation; context and matcher hits are inputs to the review, not verdicts.

`process` and `revalidate` handle at most four files per invocation, with one batch at a time and at most 30 turns per batch. For supplemental review, `process <run-directory> <file-list.json>` accepts a JSON array of up to four tracked paths; keep that regular-file manifest directly in the run directory, outside guest-writable `data/`. This directly reviews files even when regex matchers found no candidates, but upstream file filters still apply (for example, `**/fixtures/**` is omitted before model processing). Compare requested paths with the completed records. Repeat batches only after inspecting completion and remaining work in `data/launch/`; do not treat a failed, refused or interrupted batch as complete. Stop on subscription quota errors. Revalidate findings, then manually trace every reported source-to-sink exploit before publishing. The exported Markdown is in `data/exported-findings/` and includes resolved/false-positive records so the review evidence stays complete.

Launch's tracked source is public. Model-backed processing sends snapshot context to OpenAI using the subscription route above; public source does not make the scanner's execution trusted. Keep credentials, client material and host sessions out of the snapshot and retain its manifest with the review evidence. Never run agent-backed `init`, `setup`, `process`, `revalidate` or `triage` against the host checkout. Default `init`/`setup` can start agents automatically.

## Coverage and limits

[INFO.md](INFO.md) describes Launch's auth boundaries and intended public surfaces, including Composer distribution, Fleet reporting and package installation outside Launch. Keep it current when those boundaries change. The Launch plugin adds first-party PHP and shell entry points that the built-in root technology detection missed, plus exact-path entry points for `wordpress-shared/plugin-release/release.ts` and `apps/docs-site/scripts/build-output.mjs`. The PHP pattern covers Fleet and the moved Headless Revalidate implementation as well as the app's loader. These candidates request investigation; they are not vulnerability findings. Inspect coverage before adding further matchers.

Composer metadata and deployment configuration are supporting review context: each package's `composer.json` and `.gitattributes`, the public index and redirect rules, the headless `composer.json`, build/include files and local Docker mounts. Priority paths draw attention to those files but do not override DeepSec's own file filters or create candidates. Compare scan records with these paths and state exclusions in the review report. The package-install documentation and ADR 0017 describe intended behavior; they are not executable entry points. A candidate-only setup change does not require running `security:subscription process`.

A whole-repository snapshot includes our PHP, TypeScript, JavaScript and shell source. DeepSec applies its own file/technology filters, so snapshot inclusion does not mean every file receives AI review. Record missed surfaces and review them explicitly. Installed WordPress/npm vendor code is absent by design. Dependency advisories, runtime deployments and Cloudflare Access policy state, full Git history, and dynamic exploit proofs need separate checks. `pnpm verify` remains the local correctness gate; DeepSec does not validate everything.

DeepSec's investigation prompt also excludes non-production code. A selected setup script or sample can be read and still excluded from findings. Inspect each analysis history's `refusal.skipped` field, record the reason, and review operational or local-development risks separately. Do not count an `analyzed` status alone as completed coverage.

Upstream: [DeepSec](https://github.com/vercel-labs/deepsec).
