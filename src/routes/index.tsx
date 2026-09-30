import { createFileRoute, Link } from "@tanstack/react-router";
import { ProjectCard } from "#/components/ProjectCard";
import { Card, Mono, Section, useAutoRefresh } from "#/components/ui";
import { getOverview } from "#/lib/api";
import type { PortView } from "#/lib/types";

export const Route = createFileRoute("/")({
	loader: () => getOverview(),
	component: Dashboard,
});

function Dashboard() {
	const { projects, unknownPorts, dockerAvailable } = Route.useLoaderData();
	useAutoRefresh();
	const running = projects.filter(
		(p) => p.status === "running" || p.status === "partial",
	).length;
	const unknown = unknownPorts.filter((p) => !p.system);

	return (
		<div className="space-y-10">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
					<p className="mt-1 text-sm text-zinc-500">
						{running} of {projects.length} running
						{unknown.length > 0 &&
							` · ${unknown.length} unknown service${unknown.length === 1 ? "" : "s"}`}
						{!dockerAvailable && " · Docker not detected"}
					</p>
				</div>
			</div>

			{projects.length === 0 ? (
				<EmptyState />
			) : (
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{projects.map((p) => (
						<ProjectCard key={p.id} project={p} />
					))}
				</div>
			)}

			{unknown.length > 0 && (
				<Section
					title="Unknown services"
					actions={
						<Link
							to="/ports"
							className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
						>
							All ports →
						</Link>
					}
				>
					<Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
						{unknown.map((p) => (
							<UnknownRow key={`${p.pid}:${p.port}`} port={p} />
						))}
					</Card>
				</Section>
			)}
		</div>
	);
}

function UnknownRow({ port }: { port: PortView }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
			<a
				href={`http://localhost:${port.port}`}
				target="_blank"
				rel="noreferrer"
				className="w-20 font-mono font-medium hover:underline"
			>
				:{port.port}
			</a>
			<span className="w-32 truncate">{port.type ?? port.process}</span>
			<Mono className="min-w-0 flex-1 truncate text-zinc-500">
				{port.cwd ?? "—"}
			</Mono>
			<Link
				to="/ports"
				search={{ register: port.port }}
				className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400"
			>
				Register project
			</Link>
		</div>
	);
}

function EmptyState() {
	return (
		<Card className="p-8 text-center">
			<h2 className="font-semibold">No projects registered yet</h2>
			<p className="mx-auto mt-2 max-w-md text-sm text-zinc-500">
				Add a <Mono>.dev/project.yaml</Mono> to a repository and register it
				from{" "}
				<Link to="/settings" className="underline">
					Settings
				</Link>
				, or pick a running service on the{" "}
				<Link to="/ports" className="underline">
					Ports
				</Link>{" "}
				page and register it there.
			</p>
		</Card>
	);
}
