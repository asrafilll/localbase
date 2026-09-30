#!/usr/bin/env node
/**
 * Installs Local Dev Hub as a macOS LaunchAgent so it starts at login and
 * restarts if it crashes. Run `pnpm build` first.
 *
 *   node scripts/launchd.mjs install     # or: pnpm agent:install
 *   node scripts/launchd.mjs uninstall
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "dev.localdevhub";
const PORT = process.env.PORT ?? "6969";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, ".output", "server", "index.mjs");
const plist = path.join(
	os.homedir(),
	"Library",
	"LaunchAgents",
	`${LABEL}.plist`,
);
const log = path.join(os.homedir(), "Library", "Logs", "local-dev-hub.log");
const domain = `gui/${process.getuid?.() ?? ""}`;

if (process.platform !== "darwin") {
	console.error(
		"LaunchAgents are macOS only. On Linux, use a systemd user service running:",
	);
	console.error(`  HOST=127.0.0.1 PORT=${PORT} node ${entry}`);
	process.exit(1);
}

const xmlEscape = (s) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bootout() {
	try {
		execFileSync("launchctl", ["bootout", `${domain}/${LABEL}`], {
			stdio: "ignore",
		});
	} catch {
		// Not loaded.
	}
}

const command = process.argv[2];
if (command === "install") {
	if (!fs.existsSync(entry)) {
		console.error(`Missing ${entry}. Run \`pnpm build\` first.`);
		process.exit(1);
	}
	fs.mkdirSync(path.dirname(plist), { recursive: true });
	fs.writeFileSync(
		plist,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(entry)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>${xmlEscape(PORT)}</string>
    <key>SHELL</key><string>${xmlEscape(process.env.SHELL ?? "/bin/zsh")}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`,
	);
	bootout();
	execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });
	console.log(`Installed ${plist}`);
	console.log(`Local Dev Hub: http://localhost:${PORT}  (logs: ${log})`);
} else if (command === "uninstall") {
	bootout();
	fs.rmSync(plist, { force: true });
	console.log(`Removed ${plist}`);
} else {
	console.error("Usage: node scripts/launchd.mjs <install|uninstall>");
	process.exit(1);
}
