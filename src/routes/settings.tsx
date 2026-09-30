import { createFileRoute, Link } from "@tanstack/react-router";
import { RegisterProject } from "#/components/RegisterProject";
import {
	Button,
	Card,
	CopyButton,
	ErrorBanner,
	Mono,
	Section,
	useAction,
} from "#/components/ui";
import { getSettings, unregisterProject } from "#/lib/api";

export const Route = createFileRoute("/settings")({
	loader: () => getSettings(),
	component: SettingsPage,
});

function SettingsPage() {
	const settings = Route.useLoaderData();
	const action = useAction();

	return (
		<div className="space-y-10">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
				<p className="mt-1 text-sm text-zinc-500">
					Hub config lives in <Mono>{settings.configPath}</Mono>. Edit it to set{" "}
					<Mono>scanDirs</Mono> or your <Mono>editor</Mono> (currently{" "}
					<Mono>{settings.editor}</Mono>).
				</p>
			</div>

			<Section title="Registered projects">
				<Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
					{settings.projects.map((p) => (
						<div
							key={p.root}
							className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
						>
							<Link
								to="/projects/$projectId"
								params={{ projectId: p.id }}
								className="w-40 truncate font-medium hover:underline"
							>
								{p.id}
							</Link>
							<Mono className="min-w-0 flex-1 truncate text-zinc-500">
								{p.rootDisplay}
							</Mono>
							{!p.ok && (
								<span className="text-xs text-red-600 dark:text-red-400">
									{p.error}
								</span>
							)}
							{p.explicit ? (
								<Button
									size="sm"
									variant="ghost"
									pending={action.pending === p.id}
									onClick={() =>
										action.run(p.id, () =>
											unregisterProject({ data: { id: p.id } }),
										)
									}
								>
									Remove
								</Button>
							) : (
								<span className="text-xs text-zinc-400">from scanDirs</span>
							)}
						</div>
					))}
					<div className="px-4 py-3">
						<RegisterProject />
					</div>
				</Card>
				<ErrorBanner error={action.error} onDismiss={action.clearError} />
			</Section>

			<Section title="Hub">
				<Card className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
						<span className="w-48 font-medium">Per-project URLs</span>
						<span className="text-zinc-600 dark:text-zinc-400">
							{settings.proxyPort ? (
								<>
									<Mono>
										http://&lt;project&gt;.localhost
										{settings.proxyPort === 80 ? "" : `:${settings.proxyPort}`}
									</Mono>{" "}
									and <Mono>&lt;service&gt;.&lt;project&gt;.localhost</Mono>
								</>
							) : settings.configuredProxyPort ? (
								`Not running: port ${settings.configuredProxyPort} is busy. Change proxyPort in config.yaml.`
							) : (
								"Disabled (proxyPort: 0)"
							)}
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
						<span className="w-48 font-medium">When the hub quits</span>
						<span className="text-zinc-600 dark:text-zinc-400">
							{settings.stopProcessesOnExit
								? "Processes it started are stopped (stopProcessesOnExit: true)."
								: "Processes it started keep running and are re-attached on the next start."}
						</span>
					</div>
				</Card>
			</Section>

			<Section title="Magic Login key">
				<Card className="space-y-4 p-4 text-sm">
					<p className="text-zinc-600 dark:text-zinc-400">
						The hub signs short-lived (60s) Ed25519 tokens with a private key
						that never leaves <Mono>{settings.hubHome}</Mono>. Give each app the{" "}
						<strong>public</strong> key in its <strong>development</strong>{" "}
						<Mono>.env</Mono> only, then add the dev login endpoint (see{" "}
						<Mono>adapters/</Mono> in this repo).
					</p>
					<div>
						<div className="mb-1 flex items-center justify-between">
							<span className="text-xs font-medium text-zinc-500">
								.env line
							</span>
							<CopyButton
								value={`DEVHUB_PUBLIC_KEY=${settings.publicKeyEnv}`}
							/>
						</div>
						<pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-950">
							DEVHUB_PUBLIC_KEY={settings.publicKeyEnv}
						</pre>
					</div>
					<div>
						<div className="mb-1 flex items-center justify-between">
							<span className="text-xs font-medium text-zinc-500">PEM</span>
							<CopyButton value={settings.publicKeyPem} />
						</div>
						<pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs dark:bg-zinc-950">
							{settings.publicKeyPem}
						</pre>
					</div>
				</Card>
			</Section>
		</div>
	);
}
