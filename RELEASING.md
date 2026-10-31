# Releasing

When the protos are released, their release workflow regenerates `src/gen/`,
updates `.proto-version` and opens a pull request here. Merging that pull
request does not publish anything.

To release, update the hand-written code, `CHANGELOG.md` and the
`package.json` version as needed, then push a matching `vX.Y.Z` tag, which runs
the npm publish workflow.
