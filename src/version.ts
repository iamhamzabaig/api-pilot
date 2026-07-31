import { createRequire } from "node:module";

// `dist/version.js` and `src/version.ts` sit at the same depth, so one relative
// path resolves package.json in both the built and the source-run case.
const requireFromHere = createRequire(import.meta.url);

export const version: string = (requireFromHere("../package.json") as { version: string }).version;
