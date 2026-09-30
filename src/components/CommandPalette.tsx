import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	getOverview,
	openRepo,
	restartProject,
	startProject,
	stopProject,
} from "#/lib/api";
import { loginAs } from "#/lib/magic-login-client";
import { rank } from "#/lib/palette";
import type { HubOverview } from "#/lib/types";

type Item = {
	id: string;
	/** Searchable text (label + hidden keywords). */
	text: string;
	label: string;
	hint?: string;
	group: string;
	run: () => unknown;
};

/** ⌘K / Ctrl+K: jump to projects, open URLs, log in as personas, start/stop. */
export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [data, setData] = useState<HubOverview | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const navigate = useNavigate();
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((o) => !o);
			}
		};
		const onOpen = () => setOpen(true);
		window.addEventListener("keydown", onKey);
		window.addEventListener("devhub:palette", onOpen);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("devhub:palette", onOpen);
		};
	}, []);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActive(0);
		setStatus(null);
		getOverview().then(setData, () => setData(null));
		setTimeout(() => input.current?.focus(), 0);
	}, [open]);

	const close = useCallback(() => setOpen(false), []);

	const items = useMemo<Item[]>(() => {
		const out: Item[] = [
			{
				id: "nav-projects",
				text: "projects dashboard home",
				label: "Projects",
				group: "Go to",
				run: () => navigate({ to: "/" }),
			},
			{
				id: "nav-ports",
				text: "ports listening processes",
				label: "Ports",
				group: "Go to",
				run: () => navigate({ to: "/ports" }),
			},
			{
				id: "nav-settings",
				text: "settings register add project magic login key",
				label: "Settings",
				group: "Go to",
				run: () => navigate({ to: "/settings" }),
			},
		];
		for (const p of data?.projects ?? []) {
			const up = p.status === "running" || p.status === "partial";
			out.push({
				id: `go-${p.id}`,
				text: `${p.name} ${p.id} project details`,
				label: p.name,
				hint: p.status,
				group: "Projects",
				run: () =>
					navigate({ to: "/projects/$projectId", params: { projectId: p.id } }),
			});
			if (p.mainUrl) {
				const url = p.mainUrl;
				out.push({
					id: `open-${p.id}`,
					text: `open ${p.name} app browser`,
					label: `Open ${p.name}`,
					hint: url.replace(/^https?:\/\//, ""),
					group: "Open",
					run: () => {
						window.open(url, "_blank", "noopener");
					},
				});
			}
			for (const s of p.services) {
				if (!s.url || s.url === p.mainUrl) continue;
				const url = s.url;
				out.push({
					id: `open-${p.id}-${s.key}`,
					text: `open ${p.name} ${s.label} ${s.key}`,
					label: `Open ${p.name} · ${s.label}`,
					hint: url.replace(/^https?:\/\//, ""),
					group: "Open",
					run: () => {
						window.open(url, "_blank", "noopener");
					},
				});
			}
			for (const l of p.links) {
				out.push({
					id: `link-${p.id}-${l.url}`,
					text: `open ${p.name} ${l.label}`,
					label: `Open ${p.name} · ${l.label}`,
					hint: l.url.replace(/^https?:\/\//, ""),
					group: "Open",
					run: () => {
						window.open(l.url, "_blank", "noopener");
					},
				});
			}
			if (p.magicLogin) {
				for (const persona of p.personas) {
					out.push({
						id: `login-${p.id}-${persona.key}`,
						text: `login ${p.name} ${persona.label} ${persona.key} ${persona.user} magic`,
						label: `Login as ${persona.label} · ${p.name}`,
						hint: persona.user,
						group: "Magic Login",
						run: () => loginAs(p.id, persona.key),
					});
				}
			}
			if (p.commandKeys.includes("start")) {
				if (up) {
					out.push({
						id: `stop-${p.id}`,
						text: `stop ${p.name}`,
						label: `Stop ${p.name}`,
						group: "Control",
						run: () => stopProject({ data: { id: p.id } }),
					});
					out.push({
						id: `restart-${p.id}`,
						text: `restart ${p.name}`,
						label: `Restart ${p.name}`,
						group: "Control",
						run: () => restartProject({ data: { id: p.id } }),
					});
				} else {
					out.push({
						id: `start-${p.id}`,
						text: `start run ${p.name}`,
						label: `Start ${p.name}`,
						group: "Control",
						run: async () => {
							const res = await startProject({ data: { id: p.id } });
							if (!res.ok) {
								// Let the project page show the conflict choices.
								navigate({
									to: "/projects/$projectId",
									params: { projectId: p.id },
								});
								throw new Error(
									`Port ${res.conflicts.map((c) => c.port).join(", ")} in use; see the project page`,
								);
							}
						},
					});
				}
			}
			out.push({
				id: `editor-${p.id}`,
				text: `edit code editor vscode cursor ${p.name}`,
				label: `Open ${p.name} in editor`,
				group: "Control",
				run: () => openRepo({ data: { id: p.id, target: "editor" } }),
			});
		}
		return out;
	}, [data, navigate]);

	const results = useMemo(
		() => rank(items, query).slice(0, 50),
		[items, query],
	);

	useEffect(() => {
		list.current
			?.querySelector(`[data-index="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (!open) return null;

	const choose = async (item: Item | undefined) => {
		if (!item) return;
		try {
			setStatus(`${item.label}…`);
			await item.run();
			close();
			router.invalidate().catch(() => {});
		} catch (err) {
			setStatus(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
			<button
				type="button"
				aria-label="Close command palette"
				tabIndex={-1}
				onClick={close}
				className="absolute inset-0 cursor-default bg-zinc-950/40 backdrop-blur-sm"
			/>
			<div
				role="dialog"
				aria-label="Command palette"
				className="relative w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
			>
				<input
					ref={input}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActive(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setActive((a) => Math.min(a + 1, results.length - 1));
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setActive((a) => Math.max(a - 1, 0));
						} else if (e.key === "Enter") {
							e.preventDefault();
							void choose(results[active]);
						} else if (e.key === "Escape") close();
					}}
					placeholder="Search projects, URLs, personas… (e.g. “fit admin”)"
					aria-label="Command"
					className="w-full border-b border-zinc-200 bg-transparent px-4 py-3 text-sm outline-none dark:border-zinc-700"
				/>
				<div ref={list} className="max-h-[50vh] overflow-y-auto py-1">
					{results.length === 0 && (
						<p className="px-4 py-6 text-center text-sm text-zinc-500">
							{data ? "No matches" : "Loading…"}
						</p>
					)}
					{results.map((item, i) => (
						<button
							key={item.id}
							type="button"
							data-index={i}
							onMouseMove={() => setActive(i)}
							onClick={() => choose(item)}
							className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${i === active ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
						>
							<span className="w-20 shrink-0 text-xs text-zinc-400">
								{item.group}
							</span>
							<span className="min-w-0 flex-1 truncate">{item.label}</span>
							{item.hint && (
								<span className="max-w-48 truncate font-mono text-xs text-zinc-400">
									{item.hint}
								</span>
							)}
						</button>
					))}
				</div>
				<div className="flex items-center justify-between border-t border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-700">
					<span className="truncate">
						{status ?? "↑↓ to move · Enter to run · Esc to close"}
					</span>
					<kbd className="rounded border border-zinc-300 px-1.5 font-sans dark:border-zinc-600">
						⌘K
					</kbd>
				</div>
			</div>
		</div>
	);
}
