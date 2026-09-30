import { useEffect, useState } from "react";
import { applyMagicLoginSetup, planMagicLoginSetup } from "#/lib/api";
import type { Persona, SetupPlan } from "#/server/magic-setup";
import { Button, Card, ErrorBanner, Mono, Section, useAction } from "./ui";

type Applied = Awaited<ReturnType<typeof applyMagicLoginSetup>>;

const input =
	"h-8 min-w-0 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

const keyFrom = (s: string) =>
	s
		.toLowerCase()
		.split("@")[0]
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/**
 * Shown on a project without Magic Login: previews what the hub would add to
 * the repo (personas, the dev-only login route, the public key) and writes
 * it on Apply. Existing files are never overwritten.
 */
export function MagicLoginSetup({
	projectId,
	onApplied,
}: {
	projectId: string;
	onApplied?: () => void;
}) {
	const action = useAction();
	const [plan, setPlan] = useState<SetupPlan | null>(null);
	const [personas, setPersonas] = useState<Persona[]>([]);
	const [applied, setApplied] = useState<Applied | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		planMagicLoginSetup({ data: { id: projectId } })
			.then((p) => {
				setPlan(p);
				setPersonas(
					p.personas.length ? p.personas : [{ key: "", label: "", user: "" }],
				);
			})
			.catch((err: Error) => setLoadError(err.message));
	}, [projectId]);

	const update = (i: number, patch: Partial<Persona>) =>
		setPersonas((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
	const valid = personas.filter(
		(p) => p.user.trim() && /^[A-Za-z0-9_-]+$/.test(p.key),
	);

	if (applied) {
		return (
			<section id="magic-login" className="scroll-mt-20">
				<Section title="Magic Login">
					<Card className="space-y-2 border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/30">
						<p className="font-medium">
							Magic Login is set up for {applied.stack}.{" "}
							{!applied.automatic
								? "A few edits are left:"
								: applied.written.length > 1
									? "Restart the app if it's running, then use the Login buttons."
									: "Use the Login buttons above."}
						</p>
						{applied.steps.length > 0 && (
							<ul className="list-disc space-y-1 pl-5">
								{applied.steps.map((s) => (
									<li key={s}>{s}</li>
								))}
							</ul>
						)}
						<p className="text-xs text-zinc-500">
							Wrote {applied.written.join(", ")}. Review the changes with{" "}
							<Mono>git diff</Mono> before committing.
						</p>
					</Card>
				</Section>
			</section>
		);
	}

	return (
		<section id="magic-login" className="scroll-mt-20">
			<Section title="Set up Magic Login">
				<ErrorBanner error={loadError} />
				{!plan && !loadError && (
					<p className="text-sm text-zinc-500">
						Looking at how this app signs users in…
					</p>
				)}
				{plan && (
					<Card className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
						<div className="flex flex-wrap items-center gap-2 px-4 py-3">
							<span className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
								{plan.stack}
							</span>
							<span
								className={`rounded-md px-2 py-0.5 text-xs ${
									plan.automatic
										? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
										: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
								}`}
							>
								{plan.automatic
									? "Works right after Apply"
									: "Needs a few edits after Apply"}
							</span>
							<span className="text-xs text-zinc-500">
								{plan.magicLogin.provider === "supabase"
									? "via local Supabase, no app code"
									: plan.magicLogin.endpoint}
							</span>
						</div>

						<div className="space-y-2 px-4 py-3">
							<div className="font-medium">Log in as</div>
							{plan.notes.map((n) => (
								<p key={n} className="text-xs text-zinc-500">
									{n}
								</p>
							))}
							{personas.map((p, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
									key={i}
									className="flex flex-wrap items-center gap-2"
								>
									<input
										className={`${input} w-40`}
										placeholder="Label"
										aria-label="Persona label"
										value={p.label}
										onChange={(e) => update(i, { label: e.target.value })}
									/>
									<input
										className={`${input} flex-1 font-mono`}
										placeholder="dev user's email"
										aria-label="Persona email"
										value={p.user}
										onChange={(e) =>
											update(i, {
												user: e.target.value,
												...(p.key === keyFrom(p.user) || !p.key
													? { key: keyFrom(e.target.value) }
													: {}),
											})
										}
									/>
									<input
										className={`${input} w-32 font-mono text-xs`}
										placeholder="key"
										aria-label="Persona key"
										value={p.key}
										onChange={(e) =>
											update(i, {
												key: e.target.value.replace(/[^A-Za-z0-9_-]/g, "-"),
											})
										}
									/>
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Remove ${p.label || p.user || "persona"}`}
										onClick={() =>
											setPersonas((ps) => ps.filter((_, j) => j !== i))
										}
									>
										✕
									</Button>
								</div>
							))}
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									setPersonas((ps) => [...ps, { key: "", label: "", user: "" }])
								}
							>
								+ Add persona
							</Button>
						</div>

						{(plan.files.length > 0 || plan.env) && (
							<div className="space-y-1 px-4 py-3">
								<div className="font-medium">Changes to the repo</div>
								{plan.files.map((f) => (
									<details key={f.path} className="group">
										<summary className="cursor-pointer text-xs">
											<Mono>{f.path}</Mono>{" "}
											<span className="text-zinc-500">
												{f.skip
													? f.mode === "create"
														? "(exists, left alone)"
														: "(already set up or missing, skipped)"
													: f.mode === "create"
														? "(new file)"
														: "(append)"}
											</span>
										</summary>
										<pre className="mt-1 max-h-72 overflow-auto rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-950">
											{f.content}
										</pre>
									</details>
								))}
								{plan.env && (
									<div className="text-xs">
										<Mono>{plan.env.file}</Mono>{" "}
										<span className="text-zinc-500">
											{plan.env.skip
												? "(DEVHUB_PUBLIC_KEY already set)"
												: "(add DEVHUB_PUBLIC_KEY, the hub's public key)"}
										</span>
									</div>
								)}
								<div className="text-xs">
									<Mono>.dev/project.yaml</Mono>{" "}
									<span className="text-zinc-500">
										(personas and magicLogin)
									</span>
								</div>
							</div>
						)}

						{plan.steps.length > 0 && (
							<ul className="list-disc space-y-1 px-4 py-3 pl-8 text-xs text-zinc-600 dark:text-zinc-400">
								{plan.steps.map((s) => (
									<li key={s}>{s}</li>
								))}
							</ul>
						)}

						<div className="flex items-center gap-3 px-4 py-3">
							<Button
								variant="primary"
								disabled={valid.length === 0}
								pending={action.pending === "apply"}
								onClick={async () => {
									const res = await action.run("apply", () =>
										applyMagicLoginSetup({
											data: { id: projectId, personas: valid },
										}),
									);
									if (res) {
										onApplied?.();
										setApplied(res);
									}
								}}
							>
								Apply
							</Button>
							<span className="text-xs text-zinc-500">
								{valid.length === 0
									? "Add at least one dev user's email."
									: "Nothing is overwritten; review with git diff afterwards."}
							</span>
						</div>
					</Card>
				)}
				<ErrorBanner error={action.error} onDismiss={action.clearError} />
			</Section>
		</section>
	);
}
