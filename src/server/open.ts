import { spawn } from "node:child_process";
import { readHubConfig } from "./registry";
import { shellEnv } from "./runner";

export type OpenTarget = "editor" | "finder" | "terminal";

async function launch(file: string, args: string[]) {
	// Editor CLIs (`code`, `cursor`) usually live on the user's shell PATH only.
	const env = await shellEnv();
	return new Promise<void>((resolve, reject) => {
		const child = spawn(file, args, { detached: true, stdio: "ignore", env });
		child.once("error", (err) =>
			reject(new Error(`Could not run ${file}: ${err.message}`)),
		);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/** Opens a registered repository folder. Paths come from the registry, never from the client. */
export async function openPath(root: string, target: OpenTarget) {
	const mac = process.platform === "darwin";
	switch (target) {
		case "editor": {
			const { editor } = await readHubConfig();
			return launch(editor, [root]);
		}
		case "finder":
			return launch(mac ? "open" : "xdg-open", [root]);
		case "terminal":
			if (mac) return launch("open", ["-a", "Terminal", root]);
			return launch("x-terminal-emulator", ["--working-directory", root]);
	}
}
