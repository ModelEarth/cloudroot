On initial agent usage, invoke a sandbox using steps in support/python/PYTHON.md

Do not execute code external to this CloudRepos webroot.
Do not modify files external to this CloudRepos webroot.
Request permission when accessing externally residing config files.

###  Start Website

In the ../CloudRoot folder, run:

PORT=3700 node chat/server.mjs

For sign-in, also run the CloudRoot Worker locally, which serves the sign-in API at http://localhost:3701/api:

cd worker && npm run dev

## Git Commits

Never add Claude Code attribution or co-authored-by lines to commits.