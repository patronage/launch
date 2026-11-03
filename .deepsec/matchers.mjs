// Entry-point coverage: these candidates request review, not a vulnerability finding.
const entryPoint = (slug, content, pattern, label) => {
  const match = pattern.exec(content);

  return match
    ? [
        {
          lineNumbers: [content.slice(0, match.index).split("\n").length],
          matchedPattern: label,
          snippet: match[0],
          vulnSlug: slug,
        },
      ]
    : [];
};

export const launchMatchers = {
  matchers: [
    {
      description:
        "Review first-party WordPress PHP, including Access, preview and revalidation boundaries.",
      examples: ["<?php\nadd_action('init', 'handler');"],
      filePatterns: [
        "apps/cms-wordpress-headless/**/*.php",
        "wordpress-shared/patronage-*/**/*.php",
      ],
      match: (content) =>
        entryPoint(
          "launch-wordpress-php",
          content,
          /<\?php\b/u,
          "First-party PHP review surface; not evidence of a vulnerability"
        ),
      noiseTier: "noisy",
      slug: "launch-wordpress-php",
    },
    {
      description:
        "Review shell entry points for deployment, archive, argument and credential handling.",
      examples: ["#!/usr/bin/env bash\nset -euo pipefail", "#!/bin/sh\nset -e"],
      filePatterns: [
        "wordpress-shared/wp-deploy/*.sh",
        "apps/cms-wordpress-headless/bin/*.sh",
      ],
      match: (content) =>
        entryPoint(
          "launch-shell-entry-point",
          content,
          /^#![^\n]*\b(?:bash|sh)\b/mu,
          "Shell entry point; trace inputs before reporting a vulnerability"
        ),
      noiseTier: "noisy",
      slug: "launch-shell-entry-point",
    },
  ],
  name: "launch-entry-points",
};
