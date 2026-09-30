import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests don't boot the Start/Nitro plugins.
export default defineConfig({
	resolve: { tsconfigPaths: true },
	test: { include: ["tests/**/*.test.ts"] },
});
