# wp-deploy

`deploy.sh` deploys a WordPress site by pushing a packaged commit to the host's Git remote. It works on Cloudways, WP Engine and Kinsta, with WordPress at the repo root or in a subfolder.

This folder is the canonical copy. Every site keeps the script in its `_build/` folder, unchanged: a site outside this repo copies the files, and a WordPress app inside it, such as [`apps/cms-wordpress-headless`](../../apps/cms-wordpress-headless/_build), symlinks them. The script's second line names its version (`# wp-deploy 2.4.1 …`), and `bash _build/deploy.sh --version` prints it. Anything that differs between sites goes in `_build/deploy.env`, not in the script. Versions up to 2.4.0 lived in Patronage's earlier `launch-wordpress` repo.

## Files

| File | Owner | Purpose |
| --- | --- | --- |
| `deploy.sh` | wp-deploy, copied or symlinked unchanged | Deploy, dry run, `verify`, audit, `prune`, `install-hook` |
| `cloudways-hook-post-receive.sh` | wp-deploy, copied or symlinked unchanged | Cloudways `post-receive` hook. It is the same file on every site and reads its settings from the server. |
| `tests/test_deploy.sh` | wp-deploy | Local tests against fake servers (see [Tests](#tests)) |
| `deploy.env.sample` | wp-deploy | Documents every setting |
| `deploy.env` | site | The site's settings. Committed, non-secret. |
| `.deploy_include.txt`, `.deploy_exclude.txt` | site | Ignored build output to add, and tracked paths to leave out |
| `kinsta-hook-post-receive.sh` | site, optional | Copy of the Kinsta server's hook. The audit and deploy compare the server's hook with it. |

## Usage

Run from anywhere in the repo:

```bash
bash _build/deploy.sh staging --dry-run   # package HEAD, show the payload, push nothing
bash _build/deploy.sh staging             # deploy
bash _build/deploy.sh production
bash _build/deploy.sh verify staging --from <ref>  # rerun a deploy's checks without pushing (see below)
bash _build/deploy.sh audit staging       # read-only report on the server's files
bash _build/deploy.sh prune staging       # list old files on the server that are safe to remove; changes nothing
bash _build/deploy.sh prune staging --delete  # back them up locally, remove them, then run the audit
bash _build/deploy.sh install-hook staging  # Cloudways only
bash _build/deploy.sh plugins             # committed plugins composer doesn't manage; local, no SSH
bash _build/deploy.sh --version
```

The dry run needs no SSH or Git remote settings, so a reviewer or CI job without the site's `.env` can run it. It lists any that a deploy would need. On WP Engine, when the Git remote settings are there, it reads the server's commit (read-only) and lists the files the deploy would remove, or warns that it would remove none (see [WP Engine](#wp-engine)). `plugins` needs none either.

Bare targets (`production`, `staging`, `development`) use `DEPLOY_HOST`. Host-prefixed targets always work: `cloudways-staging`, `wpe-production`, `kinsta-staging`, and so on.

The script deploys the committed `HEAD`. It refuses to run with uncommitted changes and never stashes, switches branches, or edits the working tree. It builds the deploy commit in a temporary Git index:

1. run `DEPLOY_BUILD_TASK`, if set
2. start from `HEAD`, add the include list, remove the exclude list
3. refuse the deploy if the payload contains `.env*`, `wp-config.php` or `wp-content/uploads/`
4. push, then check the server (see [Hosts](#hosts))

**Builds read the working tree.** The build and the include list read the working tree, not `HEAD`. Gitignored local files, such as a build tool's local config, can change what the build produces and so change the payload. The clean-tree check doesn't see them. Before a first deploy with this script, or when a payload looks wrong, run the dry run from a fresh clone, or compare the payload with the server (see [Adopting on a site](#adopting-on-a-site)).

A deploy has succeeded only when the script exits 0 after printing `Deploy to <target> complete`. Don't count a deploy as done from the `git push` output alone.

**When the push landed but the checks failed.** Exit 2 means the host installed the push and a check after that failed (for example an SSH session that timed out or dropped). The script prints `deploy: deploy completed; verification failed: <reason>`. Exit 1 means the deploy failed, or the script could not prove the host installed it. The script counts a push as installed when:

- Cloudways: the hook reported `DEPLOY_OK` and the server's branch is the pushed commit
- Kinsta: the server's checkout matches the pushed commit. An SSH failure while reading it exits 1.
- WP Engine: the changed files on the server match the deploy. A matching branch only means WP Engine accepted the push, so an SSH failure before the file check, or files that still differ after the last check, exit 1.

The script also prints the command that reruns the checks when a failure comes after one of these:

- The script read the server's branch and it is the pushed commit. On Cloudways, the hook must also have reported `DEPLOY_OK`.
- The push succeeded but the script could not read the server's branch to confirm it.

It prints no such command when Cloudways's hook did not report `DEPLOY_OK`, even though the branch may hold the push: fix the hook, then redeploy. It also prints none when the server's branch is not the pushed commit. Otherwise, don't redeploy to retry the checks: a new deploy pushes a new commit and finds no file changes to check or remove. Run the printed command instead:

```bash
bash _build/deploy.sh verify staging --from <ref>
```

`verify` pushes nothing. It refuses a server commit that has no `Deployed-by: wp-deploy` trailer. It reads the server's current deploy commit and checks the files that changed since `<ref>`, the server's commit before the deploy. On WP Engine it also removes the files the deploy deleted, with the same rules as a deploy.

- Without `--from`, `<ref>` is the commit the deploy replaced: the server commit's parent when the deploy built on it, or else the commit named in its `Replaces:` trailer. A deploy commit with no parent carries that trailer: a deploy with `DEPLOY_NEW_HISTORY=true`, or one over a commit it couldn't build on.
- When the server's commit names neither, as after a first deploy, `verify` checks every file in the commit and removes none.
- `verify` removes files only when `<ref>` is the commit the deploy replaced. Against an older deploy commit, or another target's, it would remove files that changed since, so it checks the added and changed files, removes none, and prints a warning. It does the same for a parentless commit without a `Replaces:` trailer.

SSH sessions send keepalives, both the script's own and git's push, fetch and `ls-remote`, so a dropped connection ends the session after about a minute instead of hanging. Git's keepalives are added to `GIT_SSH_COMMAND`, else `core.sshCommand`, else `ssh`; a `GIT_SSH` program is left as is.

## Settings

The script reads settings from three places. The first one that sets a value wins:

1. the environment
2. `.env` next to `_build/`: personal or secret values, such as Cloudways SSH users. Most sites gitignore it.
3. `_build/deploy.env`: the site's settings, committed

Copy [`deploy.env.sample`](deploy.env.sample) to `deploy.env` and fill it in. The sample documents every setting. The most common ones:

| Setting | Default | Notes |
| --- | --- | --- |
| `DEPLOY_HOST` | none | `cloudways`, `wpengine` or `kinsta` |
| `DEPLOY_REMOTE_BRANCH` | `master` | The branch the host installs. Some sites use `main`. |
| `DEPLOY_BUILD_TASK` | none | Shell command run before packaging. If it's empty, the script says there is no build step. |
| `DEPLOY_BUILD_DIR` | `.` | Folder the build runs in. Use `..` when `wordpress/_build/` builds from a `package.json` at the repo root. |
| `DEPLOY_WORDPRESS_DIR` | `.` | Only needed when `_build/` is outside the WordPress folder |
| `DEPLOY_INCLUDE_FILE`, `DEPLOY_EXCLUDE_FILE` | `_build/.deploy_include.txt`, `_build/.deploy_exclude.txt` | Some older sites name their lists differently |

**Host-managed files.** Host-provided files, such as WP Engine's and Kinsta's mu-plugins, are listed in one block near the top of `deploy.sh` (`Host-managed paths`). Deploys never delete them, and the audit doesn't report them. When a host adds a platform file, add it to that block here and release a new version, rather than editing a site's copy. A site that needs a different list sets `DEPLOY_SERVER_MANAGED_REGEX`, which replaces the host lists too.

The script reads values literally. It doesn't expand `$VARS` or run commands in them, and it strips quotes around a whole value.

## Layouts

The script works out the layout from where the WordPress folder sits in the Git repo. You don't set it.

| Layout | Example | `DEPLOY_WORDPRESS_DIR` | What is pushed |
| --- | --- | --- | --- |
| WordPress in a subfolder, `_build/` inside it | `wordpress/_build/` | `.` (default) | WP Engine and Kinsta get a commit holding only `wordpress/`. Cloudways gets the whole packaged commit, and its hook extracts `wordpress/`. |
| WordPress at the repo root | `_build/` at the root | `.` (default) | The whole packaged commit |
| `_build/` at the root, WordPress in a subfolder | `_build/` next to `wordpress/` | `wordpress` | Same as the first row |

Include and exclude entries are always relative to the WordPress folder.

**The host receives no source history.** A pushed commit never has a source commit as parent, so the host's Git repo gets deploy payloads and nothing else: no files deleted from the repo before they were deployed, such as old `auth.json` or `.env` files. Each deploy commit builds on the server's previous one when every commit behind it is a deploy commit from this script (marked `Deployed-by: wp-deploy <version>`), so Git sends only the files that changed. Otherwise, as on the first deploy and the first one after a 2.0.0 to 2.2.2 deploy, it has no parent, Git sends the whole payload, and the force-push replaces the host's branch. Versions 2.0.0 to 2.2.2 pushed the repo's history (see the 2.2.3 changelog entry).

The host's repo therefore keeps every payload deployed since the chain began. To start a new chain, for example after a secret was deployed and removed, run one deploy with `DEPLOY_NEW_HISTORY=true`. That stops the branch referencing the old chain, but its objects stay in the host's repo until the host's Git deletes unreferenced objects, so rotate the secret and clear the host's repo (see [Clearing the host's repo](#clearing-the-hosts-repo)). Deploying from a clone that doesn't have the server's deploy commit fetches it first, which downloads that chain, every deployed version of every file, once.

## Hosts

After every push, the script reads the files the deploy changed on the server over SSH. It checks that each file matches the deployed version and that each deleted file is gone. Each host installs a push differently.

### Cloudways

- The repo's `cloudways-hook-post-receive.sh` installs each push. It extracts the WordPress folder into the webroot and deletes the files the push removed, except protected paths (`wp-config.php`, `.htaccess`, uploads, caches). It prints `DEPLOY_OK <commit>` only when everything succeeded, and the script requires that line.
- The hook is the same on every site. `install-hook` writes the site's settings next to it on the server, in `<git dir>/deploy-hook.env`: webroot, branch, WordPress folder and the two regexes. It also creates the bare repo if it doesn't exist yet.
- Before every deploy, the script compares the server's hook and `deploy-hook.env` with what the repo would install. It stops if they differ. Review the difference, then run `bash _build/deploy.sh install-hook <target>`. Changing `DEPLOY_REMOTE_BRANCH`, `DEPLOY_WORDPRESS_DIR` or the regexes also means reinstalling.
- Settings: `COMPOSE_CLOUDWAYS_<ENV>_SERVER_IP`, `_GIT_PATH` (the app's `private_html`) and `_PROJECT_REPO` in `deploy.env`. Cloudways shows the app folder in two forms, and either works as `_GIT_PATH`: `/home/master/applications/<app>/private_html` or `/home/<server-id>.cloudwaysapps.com/<app>/private_html`. `COMPOSE_CLOUDWAYS_<ENV>_SSH_USER` goes in `.env`. The webroot defaults to `<GIT_PATH>/../public_html`.
- Cloudways has no development target.

### WP Engine

- **Git Push and SSH are separate grants.** WP Engine's Git remote (`git@git.wpengine.com:<install>.git`) accepts only keys added under **Git Push** for that environment. The SSH gateway (`<install>@<install>.ssh.wpengine.net`) accepts only keys added under **SSH Gateway**. The script needs both: Git Push for the deploy, SSH for the checks. If `audit` prints `Server master: unreadable (git ls-remote failed; SSH works)`, the Git Push key is missing.
- **WP Engine doesn't delete removed files.** It adds and overwrites files, then prints `git.wpengine.com: complete!`, but files the push deleted stay on the server. Plugins removed from the repo keep running. After the push, the script checks the changed files and removes the deleted ones over SSH, with the same rules as the Cloudways hook: it never removes directories, the plugin and theme roots, or WP Engine's own files (`_wpeprivate/`, `wp-content/mysql.sql`, WP Engine's mu-plugins). WP Engine can finish installing after the push returns, so the script checks up to 6 times, 10 seconds apart.
- **The script removes files only after its own deploy commit.** The deleted files are the ones in the server's previous commit that aren't in the payload. That is safe only when the previous commit is a wp-deploy commit (it has a `Deployed-by: wp-deploy` trailer). WP Engine commits to the install's repo itself, for example `Upgraded WordPress from X to Y` when it upgrades core, and those commits can snapshot the whole webroot, WordPress core included. When the server's commit has no trailer, the deploy installs and verifies the changed files, removes nothing, and prints a warning naming that commit. Review what is left with `audit`, then `prune`. The next deploy follows a wp-deploy commit and removes files again.
- **The SSH gateway strips quotes from commands, and it has no `git`.** The script sends its remote scripts on stdin to `bash -s`, never on the command line. It hashes files with `sha1sum`, which gives the same IDs as `git hash-object`.
- The first deploy to an empty install pushes a placeholder commit, marked as a wp-deploy commit, and asks you to run the deploy again.
- `<install>.git` and `production/<install>.git` name the same repo. Set `COMPOSE_WPE_<ENV>` to the install name only. Staging and production installs can have unrelated names.
- The first deploy with this script syncs every plugin to the repo's version. On a site where plugins auto-update, that can downgrade a plugin. Check the dry run first.

### Kinsta

- **Kinsta installs a push with `git checkout -f <branch>`.** A `post-receive` hook in `/www/<folder>/private/<repo>.git` checks the branch out into `/www/<folder>/public`. The checkout uses the server repo's index, so it removes files a deploy deletes. It never touches files that were never deployed, such as `wp-config.php`, uploads and plugins installed on the server.
- **The checkout installs the whole pushed tree.** If WordPress lives in a subfolder and the whole repo were pushed, the site would end up in `public/wordpress/` and every previously deployed file would be deleted. The script prevents this by pushing a commit of the WordPress folder alone.
- **The hook prints nothing and ignores other branches.** The script checks the result itself: it compares the server repo's index with the pushed commit (`git diff-index --cached`, read-only), then checks the changed files in the webroot. A push to a branch the hook doesn't install fails with "checkout does not match the push". Set `DEPLOY_REMOTE_BRANCH` to the hook's branch.
- Leave Kinsta's hook in place; the script doesn't install one. If the site commits a copy as `_build/kinsta-hook-post-receive.sh`, the audit reports whether the server's hook matches it.
- SSH uses a per-site port: set `COMPOSE_KINSTA_<ENV>` (the `user@host` login) and `COMPOSE_KINSTA_<ENV>_PORT` from MyKinsta. Kinsta's `kinsta-mu-plugins` count as server-managed.
- The audit also lists deployed files that were edited or removed on the server since the last deploy.
- Kinsta can recreate staging containers, which changes their SSH host keys. The first deploy afterwards fails host-key verification. Check the new key before accepting it.

## Audit

`bash _build/deploy.sh audit <target> [--verbose]` is read-only. It works on all three hosts and reports:

- the script version, the server's deploy commit, and whether the hook matches
- a warning, first in the report and again above the summary, for `.env` files in the webroot: `.env` in any folder and `.env.*` at the top, the `.env` part of the forbidden-payload regex. It skips `wp-content/uploads/`. They usually hold secrets, and the web server may serve them. Check with `curl -I https://<site>/<path>` and move them out of the webroot; deploys and `prune` never remove them.
- excluded paths that exist on the server
- files deleted from the repo that are still on the server. Older deploys left these, and new deploys don't remove them. Files the exclude list matches are left out (they are listed as excluded paths, and `prune` keeps them); the section says how many.
- plugins, themes and mu-plugins on the server that were never in Git
- every plugin on the server with its WP-CLI status and source (composer, tracked, excluded or untracked)
- a warning for composer packages on the server that WP-CLI finds no plugin file in (`no-plugin-file`). WordPress doesn't load them. Usually the package's zip nests the plugin one folder too deep.
- **Not managed by composer**: every plugin and mu-plugin that `composer.lock` doesn't install, with its status and version, in two groups: (a) committed to the repo, and (b) on the server only, meaning someone added it outside the repo. Host-managed mu-plugins are left out. A summary line gives both counts.
- **composer.json requirements missing from composer.lock**: packages `composer.json` requires (`require` and `require-dev`, without platform requirements such as `php` and `ext-*`) that the lock doesn't list. `composer install` doesn't install them until someone updates and commits the lock. The section appears only when both files are committed next to each other.

The audit changes nothing and exits 0 whatever it finds.

The files deleted from the repo that are still on the server can be removed with [`prune`](#prune).

`bash _build/deploy.sh plugins` prints group (a) from the local repo alone, without SSH. It lists the plugins and mu-plugins committed at `HEAD` that `composer.lock` doesn't install, with versions from their plugin headers and a note on any that the exclude list keeps off the server. It also prints the composer.json requirements missing from composer.lock. It can't show active or inactive status; that needs `audit`. Treat its findings as a list to review: some untracked plugins are installed on the server on purpose. Remove files as a separate, approved step.

## Prune

Deploys remove the files they delete. They can't remove files that older deploys, other tools or WP Engine left behind, such as old plugin versions and unused composer libraries. The audit lists these under "Files deleted from the repo that are still on the server". `prune` removes them:

```bash
bash _build/deploy.sh prune staging [--verbose]   # dry run: list what would be removed and what is kept
bash _build/deploy.sh prune staging --delete      # back up, remove, check, then run the audit
```

It takes the same targets as a deploy. Without `--delete` it changes nothing. It starts from the audit's list, so it only considers files that were committed to the repo at some point and deleted since. Files that were never in Git, such as uploads and plugins installed on the server, are never candidates. It also needs the server's deploy commit (on WP Engine, Git Push access).

It removes two kinds of file:

- **Older files of plugins, themes and mu-plugins still in the repo or `composer.lock`**, such as files a plugin update dropped
- **Other files deleted from the repo, outside `wp-content/`**, such as a root `vendor/` folder or renamed files

It keeps, and lists with counts:

- files in the server's current deploy commit: deploys still install them, for example once-committed build output on the include list, or files `HEAD` deletes that are not deployed yet
- files matched by the include or exclude list
- files in plugins, themes and mu-plugins that are no longer in the repo or `composer.lock`. Someone may have installed the plugin on the server since. Remove those in WordPress, or by hand after checking.
- other `wp-content/` content: uploads, languages, caches and plugin data
- server-managed paths, secrets and server configuration (`.env*`, `wp-config.php`, `.htaccess`, `.user.ini`), whatever the regex settings say

With `--delete`, it first streams the files into a local tarball, `~/wp-deploy-backups/<repo>-<target>-<time>.tar.gz` (set `DEPLOY_PRUNE_BACKUP_DIR` to change the folder; keep it outside the repo). It removes nothing unless the tarball holds every file. It then removes the files with the same rules deploys use, removes directories left empty, checks that every file is gone, and runs the audit. To restore, extract the tarball in the webroot.

Review the dry run first, on staging before production. Deploys own the plugin folders they install. A plugin that updated itself on the server can have files the repo's history deleted.

## Adopting on a site

One PR per site:

1. Copy `deploy.sh` and `cloudways-hook-post-receive.sh` from this folder unchanged (inside this repo, symlink them instead). Copy `deploy.env.sample` alongside them if the site wants it handy. Delete the old per-environment Cloudways hooks and `cloudways-init.sh`; `install-hook` replaces them.
2. Write `_build/deploy.env`. Move the old script's build command to `DEPLOY_BUILD_TASK`, its branch to `DEPLOY_REMOTE_BRANCH`, and its host settings from `.env` into `deploy.env`. Keep SSH users in `.env`.
3. Run `bash _build/tests/test_deploy.sh`, then compare `--dry-run` with the old payload. Run the dry run from a fresh clone, so gitignored local files can't change the build (see [Usage](#usage)), or compare it with the server's commit: `git fetch <host's Git remote> <branch>`, then `git diff --stat FETCH_HEAD <commit>`, where `<commit>` is the dry run's `Split commit` if it printed one, otherwise its `Deploy commit`.
4. Run `audit` against staging. On Cloudways, review and run `install-hook` for each environment.
5. Deploy staging, check the site, then deploy production.
6. Clean up what the audit found in a separate, approved step (`prune` covers files deleted from the repo), and record the site's version wherever you track the rollout.

To check that a site's copy is current, compare `sha1sum _build/deploy.sh` with the canonical file at the version its header names.

## Clearing the host's repo

A deploy with 2.0.0 to 2.2.2 pushed the source repo's history to the host. Later deploys stop referencing it, but the objects stay until the host's Git deletes them. First rotate every secret that was ever committed under the pushed folder (the whole repo on Cloudways), such as license keys in `auth.json` and keys in `.env` files. Then:

- **Cloudways and Kinsta**: after a current deploy, run `git --git-dir=<repo> reflog expire --expire=now --all && git --git-dir=<repo> gc --prune=now` over SSH. On Cloudways you can instead recreate the repo with `install-hook` and deploy again.
- **WP Engine**: a current deploy force-replaces the branch, like WP Engine's documented Git Push reset, but WP Engine doesn't say whether it deletes the old objects. For certainty, ask WP Engine support to purge or recreate the install's Git Push repo.

## Tests

```bash
pnpm --filter @launch/wp-deploy test     # or: bash tests/test_deploy.sh, from this folder
```

The tests deploy to fake servers through a fake `ssh`. Nothing touches a real host. They cover:

- every host (Cloudways, WP Engine, Kinsta) with WordPress at the repo root, in `wordpress/` with `wordpress/_build/`, and (for Kinsta and Cloudways) in `wordpress/` with `_build/` at the root
- per case: a dry run, install-hook (Cloudways) or remote preparation (WP Engine), two deploys, file verification, removal of deleted files, protected paths, and the audit
- the "Not managed by composer" audit section and the local `plugins` report, WP Engine's managed mu-plugins, the no-plugin-file warning, and composer.json requirements missing from composer.lock
- `prune` on every host and layout: what it removes and keeps, the backup, the audit afterwards, and a second run with nothing to remove
- the audit's `.env` warning and its handling of excluded files deleted from the repo
- dry runs without SSH or Git remote settings on every host, while deploys and SSH commands still require them
- `verify` after a deploy whose SSH checks failed: exit 1 or 2 by whether the install is proven, the verify hint, stale-file removal without a push, and its options
- the Cloudways hook, list parsing, settings precedence, payload checks, remote quoting, the no-`git` hash, a 1500-file verification, and Kinsta failure modes

The fake WP Engine gateway strips quotes and has no `git`, like the real one. The tests need bash (3.2 or later), git and coreutils. They are this package's `test` script, so `pnpm verify` runs them.

## Changelog

- **2.4.1**: No behavior change. The canonical copy moved to `wordpress-shared/wp-deploy` in patronage/launch; the header and docs say so.
- **2.4.0**: New `verify <target> [--from <ref>]` reruns a deploy's checks, and on WP Engine its stale-file removal, without pushing. A deploy commit with no parent carries a `Replaces: <commit>` trailer naming the server's commit it replaced, which `verify` uses like a parent. After the host has installed the push, a failure prints `deploy completed; verification failed` and exits 2 instead of 1; on WP Engine, only a file check that matches proves the install. A failure after the script confirms the server's branch is the pushed commit (on Cloudways, also after `DEPLOY_OK`), or after a push it can't confirm, names the `verify` command. SSH sessions, including git's, set `ServerAliveInterval=15` and `ServerAliveCountMax=4`, so a dropped connection no longer hangs the deploy.
- **2.3.0**: On WP Engine, a deploy removes files from the server only when the server's previous commit is a wp-deploy commit. A first deploy over WP Engine's own commit deleted WordPress core: WP Engine had committed an "Upgraded WordPress" snapshot of the webroot, and the deploy removed every file in it that wasn't in the payload. Against any other commit the deploy now removes nothing and prints a warning that names the commit and points to `audit` and `prune`. Deploy commits from 2.0.0 to 2.2.2 have no trailer, so the first 2.3.0 deploy after one removes nothing either. On WP Engine, `--dry-run` reads the server's commit when the Git remote settings are there and lists the files the deploy would remove. The placeholder commit for an empty install carries the trailer.
- **2.2.3**: Deploys push no Git history. From 2.0.0 to 2.2.2, the deploy commit's parent was the source `HEAD`, so every push uploaded the repo's history to the host: on WP Engine and Kinsta the WordPress folder's history (through the subtree split), on Cloudways and repo-root layouts the whole repo's. That history can hold old `auth.json` license tokens and `.env` files. The deploy commit and the split commit never have a source parent: they build on the server's previous deploy commit when its history holds only deploy commits, and otherwise have no parent. The split no longer needs `git subtree`. `DEPLOY_NEW_HISTORY=true` pushes a commit with no parent, to start a new chain. Deploy commits carry `Source:` and `Deployed-by:` trailers, and the audit prints the server deploy commit's subject, and its source when the trailer is there, for every layout. Sites that deployed with 2.0.0 to 2.2.2 should rotate secrets that were ever committed and clear the host's repo (see [Clearing the host's repo](#clearing-the-hosts-repo)).

- **2.2.2**: No `deploy.sh` behavior change. The separate `db.sh` export tool work again on OpenSSH 10.2, which prints a post-quantum warning on every WP Engine connection: the SSH check reads the last line of output and prints the ssh output when it fails. `db.sh`'s development target connects to the development host, not the staging host.
- **2.2.1**: `--dry-run` no longer needs SSH or Git remote settings. The audit warns about `.env` files in the webroot, and leaves exclude-list matches out of the deleted-files list and its count. The docs give both Cloudways `GIT_PATH` forms.
- **2.2.0**: `prune <target>` lists files deleted from the repo that are still on the server, grouped by what it removes and keeps. `--delete` backs them up to a local tarball, removes them and runs the audit. The audit points to it.
- **2.1.0**: WP Engine's mu-plugins count as server-managed, and host file lists live in one block at the top of `deploy.sh`. The audit adds "Not managed by composer" and composer.json requirements missing from composer.lock. New `plugins` command. README note on build inputs.
- **2.0.1**: Removing more than 20 stale files on WP Engine no longer aborts with exit 141.
- **2.0.0**: One script for Cloudways, WP Engine and Kinsta, for every layout.
