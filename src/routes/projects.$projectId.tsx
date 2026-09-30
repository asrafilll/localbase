import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { LogViewer } from "#/components/LogViewer";
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
	restartProject,
	runCommand,
	startProject,
	stopCommandRun,
	stopProject,
	trustProject,
} from "#/lib/api";
import { loginAs, loginIntoScenario } from "#/lib/magic-login-client";
import type { ProjectDetail, RunView } from "#/lib/types";

export const Route = createFileRoute("/projects/$projectId")({
	loader: ({ params }) => getProjectDetail({ data: { id: params.projectId } }),
	component: ProjectPage,
});

function ProjectPage() {
	const project = Route.useLoaderData();
	const action = useAction();
	const [selectedRun, setSelectedRun] = useState<string | null>(null);
	useAutoRefresh();

	const id = project.id;
	const runId = selectedRun ?? project.runs[0]?.id ?? null;
	const isUp = project.status === "running" || project.status === "partial";
	const hasStart = project.commandKeys.includes("start");
	const selectRun = (run: RunView | undefined) => run && setSelectedRun(run.id);

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
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{project.mainUrl && (
							<ExternalLink href={project.mainUrl}>Open App</ExternalLink>
						)}
						{hasStart &&
							(isUp ? (
								<>
									<Button
										size="sm"
										pending={action.pending === "restart"}
										onClick={() =>
											action
												.run("restart", () => restartProject({ data: { id } }))
												.then(selectRun)
										}
									>
										Restart
									</Button>
									<Button
										size="sm"
										variant="danger"
										pending={action.pending === "stop"}
										onClick={() =>
											action.run("stop", () => stopProject({ data: { id } }))
										}
									>
										Stop
									</Button>
								</>
							) : (
								<Button
									size="sm"
									variant="primary"
									pending={action.pending === "start"}
									onClick={() =>
										action
											.run("start", () => startProject({ data: { id } }))
											.then(selectRun)
									}
								>
									Start
								</Button>
							))}
					</div>
				</div>
				<ErrorBanner error={project.error ?? null} />
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
								{s.url && <ExternalLink href={s.url}>Open</ExternalLink>}
							</div>
						))}
					</Card>
				</Section>
			)}

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
							Add a <Mono>magicLogin.endpoint</Mono> to{" "}
							<Mono>.dev/project.yaml</Mono> to enable one-click login.
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
										{s.seed && (
											<>
												seed <Mono>{s.seed}</Mono>
											</>
										)}
										{s.seed && s.persona && " · "}
										{s.persona && (
											<>
												as <Mono>{s.persona}</Mono>
											</>
										)}
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

			{project.commands.length > 0 && (
				<Section title="Commands">
					{!project.trusted && (
						<Card className="space-y-3 border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950/30">
							<p>
								<strong>Review before running.</strong> These commands come from
								this repository's <Mono>.dev/project.yaml</Mono> and run as your
								user. You'll be asked again if they change.
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
											.then(selectRun)
									}
								>
									Run
								</Button>
							</div>
						))}
					</Card>
				</Section>
			)}

			{project.runs.length > 0 && (
				<Section title="Output">
					<div className="flex flex-wrap gap-2">
						{project.runs.slice(0, 10).map((r) => (
							<RunChip
								key={r.id}
								run={r}
								active={r.id === runId}
								onSelect={() => setSelectedRun(r.id)}
								onStop={() =>
									action.run(`stop-${r.id}`, () =>
										stopCommandRun({ data: { runId: r.id } }),
									)
								}
							/>
						))}
					</div>
					{runId && <LogViewer runId={runId} />}
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
	}[run.status];
	return (
		<div
			className={`flex items-center overflow-hidden rounded-md border text-xs ${active ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-700"}`}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800"
			>
				<span className="font-medium">{run.commandKey}</span>
				<span className={color}>
					{run.status === "failed" ? `failed (${run.exitCode})` : run.status}
				</span>
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
