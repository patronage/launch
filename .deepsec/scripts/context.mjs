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
