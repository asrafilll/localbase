/** Fake seed script for the demo scenarios: writes the state the app displays. */
import { writeFileSync } from "node:fs";

const scenarios: Record<string, { label: string; ptRemaining: number }> = {
	"pt-seven-left": {
		label: "Member with 7/10 PT sessions remaining",
		ptRemaining: 7,
	},
	expired: { label: "Expired membership", ptRemaining: 0 },
};

const name = process.argv[2] ?? "";
const scenario = scenarios[name];
if (!scenario) {
	console.error(
		`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(", ")}`,
	);
	process.exit(1);
}
console.log(`Seeding "${scenario.label}"...`);
writeFileSync(
	new URL("./.scenario.json", import.meta.url),
	JSON.stringify(scenario),
);
console.log("Done.");
