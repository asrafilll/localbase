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

const service = `${domain}/${LABEL}`;

function launchctl(...args) {
	try {
		execFileSync("launchctl", args, { stdio: "pipe" });
		return { ok: true, output: "" };
	} catch (err) {
		return {
			ok: false,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim(),
		};
	}
}

const sleep = (ms) =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isLoaded = () => launchctl("print", service).ok;

/** Unloads the agent and waits until launchd has really let go of it. */
function bootout() {
	if (!isLoaded()) return;
	launchctl("bootout", service);
	for (let i = 0; i < 50 && isLoaded(); i++) sleep(100);
}

/**
 * `bootstrap` fails with "5: Input/output error" while a previous copy is
 * still unloading (bootout is asynchronous) or when the label was disabled,
 * so enable it and retry a few times before giving up.
 */
function bootstrap() {
	launchctl("enable", service);
	let last = { ok: false, output: "" };
	for (let attempt = 0; attempt < 5; attempt++) {
		last = launchctl("bootstrap", domain, plist);
		if (last.ok || isLoaded()) return;
		bootout();
		sleep(500 * (attempt + 1));
	}
	// Older macOS releases still accept the legacy command.
	if (launchctl("load", "-w", plist).ok && isLoaded()) return;
	console.error(`launchctl bootstrap ${domain} ${plist} failed:`);
	console.error(last.output || "(no output)");
	console.error(`
Things to try:
  plutil -lint ${plist}
  launchctl bootout ${service}; pnpm agent:install
  lsof -iTCP:${PORT} -sTCP:LISTEN   # is something else (e.g. \`pnpm start\`) on port ${PORT}?
  tail -50 ${log}
Or run the hub without launchd: pnpm start`);
	process.exit(1);
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
	bootstrap();
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
