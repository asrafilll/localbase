import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LogViewer } from "#/components/LogViewer";
import { MagicLoginSetup } from "#/components/MagicLoginSetup";
import { ProjectWarnings } from "#/components/ProjectCard";
import { formatUsage, StartControls } from "#/components/StartControls";
import {
	Button,
	Card,
	ErrorBanner,
	ExternalLink,
	Mono,
	Section,
	StatusDot,
	StatusLabel,
	useAction,
	useAutoRefresh,
} from "#/components/ui";
import {
	getProjectDetail,
	openRepo,
	runCommand,
	snapshotAction,
	stopCommandRun,
	trustProject,
} from "#/lib/api";
import { loginAs, loginIntoScenario } from "#/lib/magic-login-client";
import type { ProjectDetail, RunView } from "#/lib/types";

export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) => getProjectDetail({ data: { id: params.projectId } }),
	component: ProjectPage,
});

/** What the output panel shows: a command run or a container's logs. */
type LogSource =
	| { kind: "run"; id: string }
	| { kind: "container"; name: string };

function ProjectPage() {
	const project = Route.useLoaderData();
	const action = useAction();
	const [source, setSource] = useState<LogSource | null>(null);
	const [startError, setStartError] = useState<string | null>(null);
	// Keeps the setup panel (and its result) visible after Apply adds magicLogin.
	const [setupDone, setSetupDone] = useState<string | null>(null);
	useAutoRefresh();

	const id = project.id;
	const current: LogSource | null =
		source ??
		(project.runs[0] ? { kind: "run", id: project.runs[0].id } : null);
	const isUp = project.status === "running" || project.status === "partial";
	const hasStart = project.commandKeys.includes("start");
	const showRun = (run: RunView | undefined) => {
		if (run) setSource({ kind: "run", id: run.id });
	};

	return (
		<div className="space-y-10">
			<header className="space-y-4">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-3">
							<h1 className="text-2xl font-semibold tracking-tight">
								{project.name}
							</h1>
							<StatusLabel status={project.status} />
						</div>
						{project.description && (
							<p className="mt-1 text-zinc-500">{project.description}</p>
						)}
						<ProjectWarnings project={project} />
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{project.mainUrl && (
							<ExternalLink href={project.mainUrl}>Open App</ExternalLink>
						)}
						{hasStart && project.trusted && (
							<StartControls
								projectId={id}
								isUp={isUp}
								onRun={showRun}
								onError={setStartError}
							/>
						)}
						{hasStart && !project.trusted && (
							<a
								href="#commands"
								className="inline-flex h-7 items-center rounded-md bg-amber-500 px-2.5 text-xs font-medium text-white hover:bg-amber-400"
							>
								Review commands to start ↓
							</a>
						)}
					</div>
				</div>
				<ErrorBanner error={project.error ?? null} />
				<ErrorBanner error={startError} onDismiss={() => setStartError(null)} />
				<ErrorBanner error={action.error} onDismiss={action.clearError} />
			</header>

			<Overview
				project={project}
				onOpen={(target) =>
					action.run(`open-${target}`, () => openRepo({ data: { id, target } }))
				}
			/>

			{project.services.length > 0 && (
				<Section title="Services">
					<Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
						{project.services.map((s) => (
							<div
								key={s.key}
								className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
							>
								<StatusDot status={s.status} />
								<span className="w-32 font-medium">{s.label}</span>
								<span className="w-20 font-mono text-xs text-zinc-500">
									{s.port ? `:${s.port}` : ""}
								</span>
								<span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
									{s.connection ? <Mono>{s.connection}</Mono> : s.detail}
								</span>
								{s.proxyUrl && (
									<a
										href={s.proxyUrl}
										target="_blank"
										rel="noreferrer"
										className="font-mono text-xs text-violet-600 hover:underline dark:text-violet-400"
									>
										{s.proxyUrl.replace(/^http:\/\//, "")}
									</a>
								)}
								{s.container && (
									<Button
										size="sm"
										variant="ghost"
										onClick={() =>
											setSource({
												kind: "container",
												name: s.container as string,
											})
										}
									>
										Logs
									</Button>
								)}
								{s.url && <ExternalLink href={s.url}>Open</ExternalLink>}
							</div>
						))}
					</Card>
				</Section>
			)}

			{project.env.length > 0 && <EnvironmentSection env={project.env} />}

			{project.links.length > 0 && (
				<Section title="Links">
					<div className="flex flex-wrap gap-2">
						{project.links.map((l) => (
							<ExternalLink key={l.url} href={l.url}>
								{l.label}
							</ExternalLink>
						))}
					</div>
				</Section>
			)}

			{project.personas.length > 0 && (
				<Section title="Personas">
					{!project.magicLogin && (
						<p className="text-sm text-zinc-500">
							One-click login isn't set up yet.{" "}
							<a href="#magic-login" className="underline">
								Set up Magic Login ↓
							</a>
						</p>
					)}
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{project.personas.map((p) => (
							<Card
								key={p.key}
								className="flex items-center justify-between gap-3 p-4"
							>
								<div className="min-w-0">
									<div className="font-medium">{p.label}</div>
									<div className="truncate font-mono text-xs text-zinc-500">
										{p.user}
									</div>
									{p.description && (
										<div className="mt-1 text-xs text-zinc-500">
											{p.description}
										</div>
									)}
								</div>
								{project.magicLogin && (
									<Button
										size="sm"
										className="!bg-violet-600 !text-white hover:!bg-violet-500"
										onClick={() =>
											loginAs(id, p.key).catch((err: Error) =>
												action.run("login", () => Promise.reject(err)),
											)
										}
									>
										Login
									</Button>
								)}
							</Card>
						))}
					</div>
				</Section>
			)}

			{(!project.magicLogin || setupDone === id) && !project.error && (
				<MagicLoginSetup
					key={id}
					projectId={id}
					onApplied={() => setSetupDone(id)}
				/>
			)}

			{project.scenarios.length > 0 && (
				<Section title="Scenarios">
					<div className="grid gap-3 sm:grid-cols-2">
						{project.scenarios.map((s) => (
							<Card
								key={s.key}
								className="flex items-center justify-between gap-3 p-4"
							>
								<div className="min-w-0">
									<div className="font-medium">{s.label}</div>
									{s.description && (
										<div className="text-xs text-zinc-500">{s.description}</div>
									)}
									<div className="mt-1 text-xs text-zinc-500">
										{[
											s.snapshot && `snapshot ${s.snapshot}`,
											s.seed && `seed ${s.seed}`,
											s.persona && `as ${s.persona}`,
										]
											.filter(Boolean)
											.join(" · ")}
									</div>
								</div>
								<Button
									size="sm"
									pending={action.pending === `scenario-${s.key}`}
									onClick={() =>
										action.run(`scenario-${s.key}`, () =>
											loginIntoScenario(id, s.key),
										)
									}
								>
									{s.persona && project.magicLogin ? "Load & Login" : "Load"}
								</Button>
							</Card>
						))}
					</div>
				</Section>
			)}

			{project.database && (
				<DatabaseSection project={project} trusted={project.trusted} />
			)}

			{project.commands.length > 0 && (
				<section id="commands" className="scroll-mt-20">
					<Section title="Commands">
						{!project.trusted && (
							<Card className="space-y-3 border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
								<p>
									<strong>Review before running.</strong> These commands
									{project.database ? " and the database target" : ""} come from
									this repository's <Mono>.dev/project.yaml</Mono> and run as
									your user. You'll be asked again if they change.
								</p>
								<Button
									variant="primary"
									size="sm"
									pending={action.pending === "trust"}
									onClick={() =>
										action.run("trust", () => trustProject({ data: { id } }))
									}
								>
									I trust these commands
								</Button>
							</Card>
						)}
						<Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
							{project.commands.map((c) => (
								<div
									key={c.key}
									className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
								>
									<span className="w-28 font-medium">{c.label}</span>
									<Mono className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">
										{c.command}
										{c.cwd && (
											<span className="text-zinc-400"> (in {c.cwd})</span>
										)}
									</Mono>
									{c.longRunning && (
										<span className="text-xs text-zinc-400">long-running</span>
									)}
									<Button
										size="sm"
										disabled={!project.trusted}
										pending={action.pending === `cmd-${c.key}`}
										onClick={() =>
											action
												.run(`cmd-${c.key}`, () =>
													runCommand({ data: { id, key: c.key } }),
												)
												.then(showRun)
										}
									>
										Run
									</Button>
								</div>
							))}
						</Card>
					</Section>
				</section>
			)}

			{(project.runs.length > 0 || current?.kind === "container") && (
				<Section title="Output">
					<div className="flex flex-wrap gap-2">
						{project.runs.slice(0, 10).map((r) => (
							<RunChip
								key={r.id}
								run={r}
								active={current?.kind === "run" && r.id === current.id}
								onSelect={() => setSource({ kind: "run", id: r.id })}
								onStop={() =>
									action.run(`stop-${r.id}`, () =>
										stopCommandRun({ data: { runId: r.id } }),
									)
								}
							/>
						))}
						{project.containers.map((name) => (
							<button
								key={name}
								type="button"
								onClick={() => setSource({ kind: "container", name })}
								className={`rounded-md border px-2.5 py-1.5 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 ${current?.kind === "container" && current.name === name ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-700"}`}
							>
								🐳 {name}
							</button>
						))}
					</div>
					{current && (
						<LogViewer
							src={
								current.kind === "run"
									? `/api/runs/${current.id}/logs`
									: `/api/containers/${encodeURIComponent(current.name)}/logs`
							}
						/>
					)}
				</Section>
			)}

			{project.extraPorts.length > 0 && (
				<Section title="Other processes in this repo">
					<Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
						{project.extraPorts.map((p) => (
							<div
								key={`${p.pid}:${p.port}`}
								className="flex flex-wrap items-center gap-4 px-4 py-3 text-sm"
							>
								<a
									href={`http://localhost:${p.port}`}
									target="_blank"
									rel="noreferrer"
									className="w-16 font-mono hover:underline"
								>
									:{p.port}
								</a>
								<span>{p.type ?? p.process}</span>
								<Mono className="min-w-0 flex-1 truncate text-zinc-500">
									{p.cwd}
								</Mono>
							</div>
						))}
					</Card>
				</Section>
			)}
		</div>
	);
}

function Overview({
	project,
	onOpen,
}: {
	project: ProjectDetail;
	onOpen: (target: "editor" | "finder" | "terminal") => void;
}) {
	return (
		<Card className="grid gap-6 p-4 md:grid-cols-[1fr_auto]">
			<dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
				<dt className="text-zinc-500">Repository</dt>
				<dd className="min-w-0 truncate font-mono text-[0.8125rem]">
					{project.rootDisplay}
				</dd>
				<dt className="text-zinc-500">Branch</dt>
				<dd>
					{project.git ? (
						<>
							<Mono>{project.git.branch}</Mono>
							<span className="ml-2 text-xs text-zinc-500">
								{project.git.changes > 0
									? `${project.git.changes} uncommitted`
									: "clean"}
								{project.git.ahead > 0 && ` · ${project.git.ahead} ahead`}
								{project.git.behind > 0 && ` · ${project.git.behind} behind`}
							</span>
						</>
					) : (
						<span className="text-zinc-400">not a git repository</span>
					)}
				</dd>
				{project.proxyUrl && (
					<>
						<dt className="text-zinc-500">Stable URL</dt>
						<dd>
							<a
								href={project.proxyUrl}
								target="_blank"
								rel="noreferrer"
								className="font-mono text-[0.8125rem] text-violet-600 hover:underline dark:text-violet-400"
							>
								{project.proxyUrl}
							</a>
						</dd>
					</>
				)}
				{project.usage && (
					<>
						<dt className="text-zinc-500">Usage</dt>
						<dd>
							{formatUsage(project.usage)}
							<span className="ml-2 text-xs text-zinc-500">
								{project.usage.processes} process
								{project.usage.processes === 1 ? "" : "es"}
								{project.containers.length > 0 &&
									` · ${project.containers.length} container${project.containers.length === 1 ? "" : "s"}`}
							</span>
						</dd>
					</>
				)}
				{project.stack.length > 0 && (
					<>
						<dt className="text-zinc-500">Stack</dt>
						<dd className="flex flex-wrap gap-1.5">
							{project.stack.map((s) => (
								<span
									key={s}
									className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800"
								>
									{s}
								</span>
							))}
						</dd>
					</>
				)}
			</dl>
			<div className="flex flex-wrap items-start gap-2 md:flex-col">
				<Button size="sm" onClick={() => onOpen("editor")}>
					Open in editor
				</Button>
				<Button size="sm" onClick={() => onOpen("finder")}>
					Show in Finder
				</Button>
				<Button size="sm" onClick={() => onOpen("terminal")}>
					Open terminal
				</Button>
			</div>
		</Card>
	);
}

function EnvironmentSection({ env }: { env: ProjectDetail["env"] }) {
	return (
		<section id="environment" className="scroll-mt-20">
			<Section title="Environment">
				<Card className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
					{env.map((e) => (
						<div key={e.dir} className="space-y-1.5 px-4 py-3">
							<div className="flex flex-wrap items-center gap-2">
								<Mono>{e.dir === "." ? "" : `${e.dir}/`}.env</Mono>
								<span className="text-xs text-zinc-500">vs {e.template}</span>
								{!e.hasEnv ? (
									<span className="text-xs font-medium text-red-600 dark:text-red-400">
										missing: copy {e.template} to .env
									</span>
								) : e.missing.length === 0 ? (
									<span className="text-xs text-emerald-600 dark:text-emerald-400">
										all keys set
									</span>
								) : (
									<span className="text-xs text-amber-600 dark:text-amber-400">
										{e.missing.length} key{e.missing.length === 1 ? "" : "s"}{" "}
										missing
									</span>
								)}
							</div>
							{e.hasEnv && e.missing.length > 0 && (
								<div className="flex flex-wrap gap-1.5">
									{e.missing.map((k) => (
										<Mono
											key={k}
											className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
										>
											{k}
										</Mono>
									))}
								</div>
							)}
						</div>
					))}
				</Card>
				<p className="text-xs text-zinc-500">
					Only key names are compared; values never leave your files.
				</p>
			</Section>
		</section>
	);
}

function DatabaseSection({
	project,
	trusted,
}: {
	project: ProjectDetail;
	trusted: boolean;
}) {
	const action = useAction();
	const [name, setName] = useState("");
	const db = project.database;
	if (!db) return null;
	const run = (a: "save" | "restore" | "delete", n: string) =>
		action.run(`${a}-${n}`, () =>
			snapshotAction({ data: { id: project.id, action: a, name: n } }),
		);

	return (
		<Section title="Database">
			<Card className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
				<div className="flex flex-wrap items-center gap-3 px-4 py-3">
					<span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
						{db.type}
					</span>
					<Mono className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-400">
						{db.target}
					</Mono>
				</div>
				{project.snapshots.map((s) => (
					<div
						key={s.name}
						className="flex flex-wrap items-center gap-3 px-4 py-2.5"
					>
						<span className="w-48 truncate font-medium">{s.name}</span>
						<span className="text-xs text-zinc-500">
							{new Date(s.createdAt).toLocaleString()} ·{" "}
							{formatBytes(s.sizeBytes)}
						</span>
						<div className="ml-auto flex gap-2">
							<Button
								size="sm"
								disabled={!trusted}
								pending={action.pending === `restore-${s.name}`}
								onClick={() => {
									if (
										confirm(
											`Replace the current ${db.type} database with snapshot "${s.name}"?`,
										)
									)
										run("restore", s.name);
								}}
							>
								Restore
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={!trusted}
								pending={action.pending === `delete-${s.name}`}
								onClick={() => {
									if (confirm(`Delete snapshot "${s.name}"?`))
										run("delete", s.name);
								}}
							>
								Delete
							</Button>
						</div>
					</div>
				))}
				<form
					className="flex gap-2 px-4 py-3"
					onSubmit={async (e) => {
						e.preventDefault();
						const n = name.trim();
						if (!n) return;
						await run("save", n);
						setName("");
					}}
				>
					<input
						value={name}
						onChange={(e) =>
							setName(e.target.value.replace(/[^A-Za-z0-9._-]/g, "-"))
						}
						placeholder="snapshot-name"
						aria-label="Snapshot name"
						className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
					/>
					<Button
						type="submit"
						variant="primary"
						disabled={!trusted || !name.trim()}
						pending={action.pending === `save-${name.trim()}`}
					>
						Save snapshot
					</Button>
				</form>
			</Card>
			{!trusted && (
				<p className="text-xs text-zinc-500">
					Trust this project's commands (below) to enable snapshots.
				</p>
			)}
			<ErrorBanner error={action.error} onDismiss={action.clearError} />
		</Section>
	);
}

function formatBytes(n: number) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function RunChip({
	run,
	active,
	onSelect,
	onStop,
}: {
	run: RunView;
	active: boolean;
	onSelect: () => void;
	onStop: () => void;
}) {
	const color = {
		running: "text-sky-600 dark:text-sky-400",
		succeeded: "text-emerald-600 dark:text-emerald-400",
		failed: "text-red-600 dark:text-red-400",
		stopped: "text-zinc-500",
		exited: "text-zinc-500",
	}[run.status];
	return (
		<div
			className={`flex items-center overflow-hidden rounded-md border text-xs ${active ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-700"}`}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800"
				title={run.adopted ? "Re-attached after a hub restart" : undefined}
			>
				<span className="font-medium">{run.commandKey}</span>
				<span className={color}>
					{run.status === "failed" ? `failed (${run.exitCode})` : run.status}
				</span>
				{run.adopted && <span className="text-zinc-400">↺</span>}
				<span className="text-zinc-400">
					{new Date(run.startedAt).toLocaleTimeString()}
				</span>
			</button>
			{run.status === "running" && (
				<button
					type="button"
					onClick={onStop}
					className="border-l border-zinc-200 px-2 py-1.5 text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:hover:bg-red-950"
					aria-label={`Stop ${run.commandKey} run`}
				>
					■
				</button>
			)}
		</div>
	);
}
