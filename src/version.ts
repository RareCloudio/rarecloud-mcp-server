// Single source of truth for the server version: read it straight from
// package.json at runtime so it can never drift from the published version.
//
// We use createRequire (not a static `import ... from '../package.json'`)
// on purpose: package.json sits outside tsconfig's rootDir (./src), so a
// static JSON import would fail the `tsc` build ("not under rootDir"). A
// runtime require sidesteps that and resolves correctly from both src/ (dev
// via tsx) and dist/ (built) — both are one level below the package root, so
// '../package.json' points at the same file in either case.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const SERVER_VERSION: string = pkg.version;
