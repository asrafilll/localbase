import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { RegisterProject } from "#/components/RegisterProject";
import { Button, Card, Mono, useAction, useAutoRefresh } from "#/components/ui";
import { getPorts, killPort } from "#/lib/api";
import type { PortView } from "#/lib/types";

export const Route = createFileRoute("/ports")({
	validateSearch: (
		search: Record<string, unknown>,
	): { register?: number; system?: boolean } => ({
		register: Number(search.register) || undefined,
		system: search.system === true || search.system === "true" || undefined,
	}),
	loader: () => getPorts(),
	component: PortsPage,
});

function PortsPage() {
	const { ports, dockerAvailable } = Route.useLoaderData();
	const { register, system } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	useAutoRefresh();
	const visible = ports.filter((p) => system || !p.system);
	const hidden = ports.length - visible.length;

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">
						Listening ports
					</h1>
					<p className="mt-1 text-sm text-zinc-500">
						Every TCP port your user's processes are listening on
						{dockerAvailable ? ", plus Docker-published ports" : ""}.
					</p>
				</div>
				<label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
					<input
						type="checkbox"
						checked={Boolean(system)}
						onChange={(e) =>
							navigate({
								search: (s) => ({
									...s,
									system: e.target.checked || undefined,
								}),
							})
						}
					/>
					Show system processes
					{hidden > 0 && !system ? ` (${hidden} hidden)` : ""}
				</label>
			</div>

			<Card className="overflow-x-auto">
				<table className="w-full min-w-[720px] text-left text-sm">
					<thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
						<tr>
							<th className="px-4 py-2.5 font-medium">Port</th>
							<th className="px-4 py-2.5 font-medium">Process</th>
							<th className="px-4 py-2.5 font-medium">Working directory</th>
							<th className="px-4 py-2.5 font-medium">Project</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
						{visible.map((p) => (
							<PortRow
								key={`${p.pid}:${p.port}`}
								port={p}
								registering={register === p.port}
							/>
						))}
						{visible.length === 0 && (
							<tr>
								<td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
									Nothing is listening.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</Card>
		</div>
	);
}

function PortRow({
	port,
	registering,
}: {
	port: PortView;
	registering: boolean;
}) {
	const [open, setOpen] = useState(registering);
	return (
		<>
			<tr className="align-top">
				<td className="px-4 py-3">
					<a
						href={`http://localhost:${port.port}`}
						target="_blank"
						rel="noreferrer"
						className="font-mono font-medium hover:underline"
					>
						:{port.port}
					</a>
					<div className="text-xs text-zinc-500">
						{port.addresses.join(", ")}
					</div>
				</td>
				<td className="px-4 py-3">
					<div>
						{port.type ?? port.process}
						{port.isHub && (
							<span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">
								this hub
							</span>
						)}
					</div>
					<div
						className="max-w-xs truncate text-xs text-zinc-500"
						title={port.commandLine}
					>
						{port.container
							? `container ${port.container}`
							: `${port.process} · pid ${port.pid}`}
					</div>
				</td>
				<td className="px-4 py-3">
					<Mono className="break-all text-zinc-600 dark:text-zinc-400">
						{port.cwd ?? "—"}
					</Mono>
				</td>
				<td className="px-4 py-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						{port.projectId ? (
							<Link
								to="/projects/$projectId"
								params={{ projectId: port.projectId }}
								className="hover:underline"
							>
								{port.projectName}
								{port.serviceKey && (
									<span className="text-zinc-500"> · {port.serviceKey}</span>
								)}
							</Link>
						) : port.isHub ? (
							<span />
						) : (
							<button
								type="button"
								onClick={() => setOpen((o) => !o)}
								className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400"
							>
								{open ? "Cancel" : "Register project"}
							</button>
						)}
						{!port.isHub && <KillButton port={port} />}
					</div>
				</td>
			</tr>
			{open && !port.projectId && (
				<tr>
					<td colSpan={4} className="bg-zinc-50 px-4 py-4 dark:bg-zinc-950">
						<RegisterProject
							initialPath={port.cwd ?? ""}
							port={port.port}
							autoFocus
						/>
					</td>
				</tr>
			)}
		</>
	);
}

function KillButton({ port }: { port: PortView }) {
	const action = useAction();
	const what = port.container
		? `stop container ${port.container}`
		: `stop ${port.process} (pid ${port.pid})`;
	return (
		<span className="flex items-center gap-2">
			{action.error && (
				<span
					className="max-w-48 text-xs text-red-600 dark:text-red-400"
					title={action.error}
				>
					{action.error}
				</span>
			)}
			<Button
				size="sm"
				variant="ghost"
				pending={action.pending === "kill"}
				title={`Free :${port.port}: ${what}`}
				onClick={() => {
					if (confirm(`Free port ${port.port}? This will ${what}.`))
						action.run("kill", () => killPort({ data: { port: port.port } }));
				}}
			>
				{port.container ? "Stop" : "Kill"}
			</Button>
		</span>
	);
}
