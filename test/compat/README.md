# Tests

Run from the repository root with Node.js >=22.19.0. The offline suites use Node built-ins and synthetic Host services; they do not start DSH, select a real model or use account credentials.

```sh
npm test
node test/work-sync-test.mjs

# Use an existing absolute scratch directory outside tracked source.
export DSH_MCP_TEST_ROOT=/absolute/path/to/scratch
npm run test:compat
npm run test:events
npm run test:job-output
```

Compatibility fixtures use unique scratch subdirectories and dynamic loopback ports, and clean up in finally blocks. Follow/bridge/security tests cover Host selection, authentication, permission limits, lifecycle and reconnect behavior. Event/output tests cover cursors, bounds, UTF-8, masking, ownership and observer cleanup. Synthetic tests do not replace actual Desktop/model integration checks.

The optional status probe only reads an explicitly selected Desktop Host:

```sh
export DSH_MCP_DESKTOP_ENDPOINT_FILE=/absolute/path/to/dsh-mcp-desktop-endpoint.json
npm run test:desktop-status
```

It expects DSH 0.2.1-rc.2, profile desktop, 21 tools, no DSH-local tool exposure and no automatic sync. It does not dispatch work or modify models/settings. The upstream stdio-bridge-test.mjs and live-e2e-test.mjs require a running Host and can execute real model/tool operations; inspect their configuration before running them.
