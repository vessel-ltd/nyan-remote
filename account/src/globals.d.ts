// ⚠️ Declaration for type checking only (at runtime Workers provides the real thing).
//
// `@cloudflare/workers-types` declares `crypto` as a **global const**, so
// TypeScript cannot reach it as `globalThis.crypto`. `shared/crypto.ts` uses
// `globalThis.crypto` **because that form works in both the agent (Node) and web (DOM)**,
// so make the same form resolve in relay (Workers) too.
// ⚠️ Removing this line breaks `npm run typecheck` (runtime behaviour does not change).
declare var crypto: Crypto
