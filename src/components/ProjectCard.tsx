import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { loginAs } from "#/lib/magic-login-client";
import type { ProjectSummary } from "#/lib/types";
import { formatUsage, StartControls } from "./StartControls";
import {
	Card,
	ErrorBanner,
	ExternalLink,
	Mono,
	StatusDot,
	StatusLabel,
} from "./ui";

export function PersonaMenu({
	project,
	onError,
}: {
	project: ProjectSummary;
	onError: (msg: string) => void;
}) {
	if (!project.magicLogin || project.personas.length === 0) return null;
	return (
		<details className="group relative">
			<summary className="inline-flex h-7 cursor-pointer list-none items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white hover:bg-violet-500 [&::-webkit-details-marker]:hidden">
				Magic Login{" "}
				<span className="text-violet-200 transition-transform group-open:rotate-180">
					▾
				</span>
			</summary>
			<div className="absolute right-0 z-10 mt-1 w-60 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
				{project.personas.map((p) => (
					<button
						key={p.key}
						type="button"
						className="block w-full px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
						onClick={(e) => {
							e.currentTarget.closest("details")?.removeAttribute("open");
							loginAs(project.id, p.key).catch((err: Error) =>
								onError(err.message),
							);
						}}
					>
						<div className="text-sm font-medium">Login as {p.label}</div>
						<div className="truncate text-xs text-zinc-500">{p.user}</div>
					</button>
				))}
			</div>
		</details>
	);
}

/** Small warning chips: missing env keys, ports shared with other projects. */
export function ProjectWarnings({ project }: { project: ProjectSummary }) {
	if (!project.envMissing && project.sharedPorts.length === 0) return null;
	return (
		<div className="mt-3 flex flex-wrap gap-1.5 text-xs">
			{project.envMissing > 0 && (
				<Link
					to="/projects/$projectId"
					params={{ projectId: project.id }}
					hash="environment"
					className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800 hover:underline dark:bg-amber-950 dark:text-amber-300"
				>
					⚠ {project.envMissing} .env key{project.envMissing === 1 ? "" : "s"}{" "}
					missing
				</Link>
			)}
			{project.sharedPorts.map((s) => (
				<span
					key={s.port}
					title={`Also configured by ${s.projects.join(", ")}: they can't run at the same time.`}
					className="rounded-md bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
				>
					:{s.port} shared with {s.projects.join(", ")}
				</span>
			))}
		</div>
	);
}

export function ProjectCard({ project }: { project: ProjectSummary }) {
	const [error, setError] = useState<string | null>(null);
	const hasStart = project.commandKeys.includes("start");
	const isUp = project.status === "running" || project.status === "partial";
	const extraLinks = project.services.filter(
		(s) => s.url && s.url !== project.mainUrl,
	);

	return (
		<Card className="flex flex-col p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<Link
						to="/projects/$projectId"
						params={{ projectId: project.id }}
						className="text-base font-semibold hover:underline"
					>
						{project.name}
					</Link>
					{project.description && (
						<p className="mt-0.5 truncate text-sm text-zinc-500">
							{project.description}
						</p>
					)}
				</div>
				<StatusLabel status={project.status} />
			</div>

			{project.error && (
				<p className="mt-3 text-xs break-words text-red-600 dark:text-red-400">
					{project.error}
				</p>
			)}

			{project.services.length > 0 && (
				<ul className="mt-4 space-y-1.5">
					{project.services.map((s) => (
						<li key={s.key} className="flex items-center gap-2 text-sm">
							<StatusDot status={s.status} />
							<span className="w-24 shrink-0 truncate text-zinc-600 dark:text-zinc-300">
								{s.label}
							</span>
							{s.url ? (
								<a
									href={s.url}
									target="_blank"
									rel="noreferrer"
									className="truncate font-mono text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
								>
									{s.url.replace(/^https?:\/\//, "")}
								</a>
							) : (
								<span className="truncate font-mono text-xs text-zinc-500">
									{s.port ? `:${s.port}` : (s.connection ?? "")}
								</span>
							)}
						</li>
					))}
				</ul>
			)}

			<dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-500">
				{project.proxyUrl && (
					<>
						<dt>URL</dt>
						<dd className="truncate">
							<a
								href={project.proxyUrl}
								target="_blank"
								rel="noreferrer"
								className="font-mono text-violet-600 hover:underline dark:text-violet-400"
							>
								{project.proxyUrl.replace(/^http:\/\//, "")}
							</a>
						</dd>
					</>
				)}
				{project.git && (
					<>
						<dt>Branch</dt>
						<dd className="truncate">
							<Mono className="text-zinc-700 dark:text-zinc-300">
								{project.git.branch}
							</Mono>
							{project.git.changes > 0 && (
								<span className="ml-2 text-amber-600">
									● {project.git.changes} changed
								</span>
							)}
						</dd>
					</>
				)}
				<dt>Repo</dt>
				<dd className="truncate font-mono">{project.rootDisplay}</dd>
				{project.usage && (
					<>
						<dt>Usage</dt>
						<dd>{formatUsage(project.usage)}</dd>
					</>
				)}
			</dl>

			<ProjectWarnings project={project} />

			<div className="mt-4">
				<ErrorBanner error={error} onDismiss={() => setError(null)} />
			</div>

			<div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
				{project.mainUrl && (
					<ExternalLink href={project.mainUrl}>Open App</ExternalLink>
				)}
				{extraLinks.slice(0, 2).map((s) => (
					<ExternalLink key={s.key} href={s.url as string}>
						{s.label}
					</ExternalLink>
				))}
				<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
					{hasStart && !project.trusted && (
						<Link
							to="/projects/$projectId"
							params={{ projectId: project.id }}
							hash="commands"
							title="Commands from a repo only run after you've reviewed them once"
							className="inline-flex h-7 items-center rounded-md bg-amber-500 px-2.5 text-xs font-medium text-white hover:bg-amber-400"
						>
							Review &amp; trust
						</Link>
					)}
					{hasStart && project.trusted && (
						<StartControls
							projectId={project.id}
							isUp={isUp}
							onError={setError}
						/>
					)}
					<PersonaMenu project={project} onError={setError} />
				</div>
			</div>
		</Card>
	);
}
