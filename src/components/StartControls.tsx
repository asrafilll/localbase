import { useEffect, useState } from "react";
import { restartProject, startProject, stopProject } from "#/lib/api";
import type { PortConflict, RunView } from "#/lib/types";
import { Button, Mono, useAction } from "./ui";

/**
 * Start / Stop / Restart for a project. Start first checks for other
 * processes on the project's ports and, if there are any, asks whether to
 * stop them, start anyway, or cancel.
 */
export function StartControls({
	projectId,
	isUp,
	size = "sm",
	onRun,
	onError,
}: {
	projectId: string;
	isUp: boolean;
	size?: "sm" | "md";
	onRun?: (run: RunView) => void;
	onError?: (message: string | null) => void;
}) {
	const action = useAction();
	const [conflicts, setConflicts] = useState<PortConflict[] | null>(null);

	const start = async (
		opts: { force?: boolean; killConflicts?: boolean } = {},
	) => {
		const res = await action.run("start", () =>
			startProject({ data: { id: projectId, ...opts } }),
		);
		if (!res) return;
		if (res.ok) {
			setConflicts(null);
			onRun?.(res.run);
		} else setConflicts(res.conflicts);
	};

	useEffect(() => {
		onError?.(action.error);
	}, [action.error, onError]);

	if (conflicts) {
		return (
			<div className="w-full space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/40">
				<p className="font-medium text-amber-900 dark:text-amber-200">
					{conflicts.length === 1 ? "A port is" : "Ports are"} already in use:
				</p>
				<ul className="space-y-1">
					{conflicts.map((c) => (
						<li key={`${c.port}-${c.pid}`}>
							<Mono>:{c.port}</Mono> —{" "}
							{c.container
								? `container ${c.container}`
								: `${c.process} (pid ${c.pid})`}
							{c.projectName
								? ` from ${c.projectName}`
								: c.cwd
									? ` in ${c.cwd}`
									: ""}
						</li>
					))}
				</ul>
				<div className="flex flex-wrap gap-2 pt-1">
					<Button
						size="sm"
						variant="danger"
						pending={action.pending === "start"}
						onClick={() => start({ killConflicts: true })}
					>
						Stop {conflicts.length === 1 ? "it" : "them"} &amp; start
					</Button>
					<Button size="sm" onClick={() => start({ force: true })}>
						Start anyway
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setConflicts(null)}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	return isUp ? (
		<>
			<Button
				size={size}
				variant="ghost"
				pending={action.pending === "restart"}
				onClick={async () => {
					const run = await action.run("restart", () =>
						restartProject({ data: { id: projectId } }),
					);
					if (run) onRun?.(run);
				}}
			>
				Restart
			</Button>
			<Button
				size={size}
				variant="danger"
				pending={action.pending === "stop"}
				onClick={() =>
					action.run("stop", () => stopProject({ data: { id: projectId } }))
				}
			>
				Stop
			</Button>
		</>
	) : (
		<Button
			size={size}
			variant="primary"
			pending={action.pending === "start"}
			onClick={() => start()}
		>
			Start
		</Button>
	);
}

export function formatUsage(u: { cpu: number; memoryMb: number }) {
	const mem =
		u.memoryMb >= 1024
			? `${(u.memoryMb / 1024).toFixed(1)} GB`
			: `${Math.round(u.memoryMb)} MB`;
	return `CPU ${u.cpu.toFixed(u.cpu < 10 ? 1 : 0)}% · ${mem}`;
}
