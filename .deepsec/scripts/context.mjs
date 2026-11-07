import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// DeepSec reads these from its project data, not from defineConfig.projects.
// Supply a guest writer after the data directory has been mounted in a runner.
// Host writes are only for initial preparation, before untrusted execution.
export const prepareReviewContext = (run, writeFiles) => {
  const info = readFileSync(new URL("../INFO.md", import.meta.url), "utf-8");

  const config = {
    priorityPaths: [
      "packages/access/",
      "wordpress-shared/patronage-access/",
      "wordpress-shared/patronage-fleet/",
      "wordpress-shared/patronage-headless-revalidate/",
      "wordpress-shared/patronage-logging/",
      "wordpress-shared/plugin-release/",
      "apps/docs-site/public/composer/",
      "apps/docs-site/composer-redirects.txt",
      "apps/docs-site/scripts/build-output.mjs",
      "apps/docs-site/blume.config.ts",
      "apps/cms-wordpress-headless/composer.json",
      "apps/cms-wordpress-headless/bin/build.sh",
      "apps/cms-wordpress-headless/_build/.deploy_include.txt",
      "apps/cms-wordpress-headless/docker-compose.yml",
      "apps/cms-wordpress-headless/wp-content/mu-plugins/",
      "apps/payload/src/app/",
      "apps/web-wordpress/app/",
    ],
  };

  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  if (writeFiles) {
    writeFiles({
      "launch/INFO.md": info,
      "launch/config.json": serialized,
    });
  } else {
    const directory = path.join(run, "data", "launch");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "INFO.md"), info);
    writeFileSync(path.join(directory, "config.json"), serialized);
  }

  writeFileSync(
    path.join(run, "review-context.json"),
    `${JSON.stringify(
      {
        configSha256: createHash("sha256").update(serialized).digest("hex"),
        infoSha256: createHash("sha256").update(info).digest("hex"),
      },
      null,
      2
    )}\n`
  );
};
