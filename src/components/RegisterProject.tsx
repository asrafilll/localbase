import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { previewRegistration, registerProject } from "#/lib/api";
import { Button, ErrorBanner, Mono, useAction } from "./ui";

type Preview = Awaited<ReturnType<typeof previewRegistration>>;

/**
 * Two-step registration: detect a `.dev/project.yaml` draft from the repo
 * (package.json, compose file, .env, framework...), let the user edit it,
 * then write it and register the folder.
 */
export function RegisterProject({
	initialPath = "",
	port,
	autoFocus,
}: {
	initialPath?: string;
	port?: number;
	autoFocus?: boolean;
}) {
	const [path, setPath] = useState(initialPath);
	const [preview, setPreview] = useState<Preview | null>(null);
	const [yaml, setYaml] = useState("");
	const action = useAction();
	const navigate = useNavigate();

	const detect = async () => {
		const res = await action.run("detect", () =>
			previewRegistration({ data: { path, port } }),
		);
		if (res) {
			setPreview(res);
			setYaml(res.yaml);
		}
	};

	const register = async () => {
		const res = await action.run("register", () =>
			registerProject({
				data: { path, port, yaml: preview?.exists ? undefined : yaml },
			}),
		);
		if (res?.id)
			navigate({ to: "/projects/$projectId", params: { projectId: res.id } });
	};

	return (
		<div className="space-y-3">
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void detect();
				}}
			>
				<input
					value={path}
					onChange={(e) => {
						setPath(e.target.value);
						setPreview(null);
					}}
					// biome-ignore lint/a11y/noAutofocus: opened on purpose by the user
					autoFocus={autoFocus}
					placeholder="~/Projects/my-app"
					aria-label="Repository path"
					className="h-8 min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
				/>
				<Button
					type="submit"
					variant={preview ? "secondary" : "primary"}
					disabled={!path}
					pending={action.pending === "detect"}
				>
					{preview ? "Detect again" : "Detect config"}
				</Button>
			</form>

			{preview && (
				<div className="space-y-2">
					{preview.exists ? (
						<p className="text-xs text-zinc-600 dark:text-zinc-400">
							<Mono>{preview.root}</Mono> already has a{" "}
							<Mono>.dev/project.yaml</Mono>; it will be used as is.
						</p>
					) : (
						<>
							<p className="text-xs text-zinc-600 dark:text-zinc-400">
								Detected: {preview.notes.join(" · ")}. Review and edit, then
								register. This file is written to <Mono>.dev/project.yaml</Mono>{" "}
								(commit it for your team).
							</p>
							<textarea
								value={yaml}
								onChange={(e) => setYaml(e.target.value)}
								spellCheck={false}
								aria-label="Detected project.yaml"
								rows={Math.min(28, yaml.split("\n").length + 1)}
								className="w-full rounded-md border border-zinc-200 bg-white p-3 font-mono text-xs leading-relaxed dark:border-zinc-700 dark:bg-zinc-950"
							/>
						</>
					)}
					<Button
						variant="primary"
						pending={action.pending === "register"}
						onClick={register}
					>
						Register project
					</Button>
				</div>
			)}
			<ErrorBanner error={action.error} onDismiss={action.clearError} />
		</div>
	);
}
