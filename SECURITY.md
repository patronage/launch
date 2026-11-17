# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's [private vulnerability reporting](https://github.com/patronage/launch/security/advisories/new) for this repository. Do not open a public issue, pull request or discussion for a suspected vulnerability, and do not include exploit details in one.

A useful report says what is affected (the app, package or plugin and its version or commit), what an attacker needs, what they can do, and how to reproduce it. A proof of concept against your own local copy is welcome. Do not test against sites you do not own.

We will acknowledge the report, keep you updated while we investigate, and credit you in the advisory if you would like.

## What is covered

- The code on the `main` branch of this repository.
- The latest published version of each `@patronage/*` npm package built from it.
- The latest published version of each `patronage/launch-*` WordPress plugin built from it.

Third-party code that Launch installs, such as WordPress core, WordPress plugins installed by Composer, Payload and npm dependencies, is out of scope here. Report those to their own maintainers. If Launch's use of a dependency makes it exploitable, that is in scope.

Launch is a set of reference sites. A site built from it is run by its own team, who are responsible for its deployment, its Cloudflare Access configuration and its secrets.
