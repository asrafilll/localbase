import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

/** Live tail of a command run, streamed over SSE from /api/runs/$runId/logs. */
export function LogViewer({ runId }: { runId: string }) {
	const router = useRouter();
	const [lines, setLines] = useState<string[]>([]);
	const [ended, setEnded] = useState(false);
	const box = useRef<HTMLPreElement>(null);
	const stick = useRef(true);

	useEffect(() => {
		setLines([]);
		setEnded(false);
		const source = new EventSource(`/api/runs/${runId}/logs`);
		source.addEventListener("line", (e) => {
			const line = JSON.parse((e as MessageEvent).data) as string;
			setLines((prev) =>
				prev.length > 4000 ? [...prev.slice(-3000), line] : [...prev, line],
			);
		});
		source.addEventListener("end", () => {
			setEnded(true);
			source.close();
			router.invalidate();
		});
		source.addEventListener("error", () => source.close());
		return () => source.close();
	}, [runId, router]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll after every new batch of lines
	useEffect(() => {
		const el = box.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	}, [lines]);

	return (
		<div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
			<pre
				ref={box}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
				className="max-h-96 min-h-32 overflow-auto p-3 font-mono text-xs leading-relaxed text-zinc-200"
			>
				{lines.map((line, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only
						key={i}
						className={
							line.startsWith("$ ")
								? "text-sky-300"
								: line.startsWith("[devhub]")
									? "text-zinc-500"
									: undefined
						}
					>
						{line}
					</div>
				))}
				{!ended && (
					<span className="inline-block h-3 w-1.5 animate-pulse bg-zinc-500 align-middle" />
				)}
			</pre>
		</div>
	);
}
