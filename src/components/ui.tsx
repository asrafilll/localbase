import { useRouter } from "@tanstack/react-router";
import {
	type ButtonHTMLAttributes,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from "react";
import type { ProjectStatus, ServiceStatus } from "#/lib/types";

type Status = ProjectStatus | ServiceStatus;

const statusStyles: Record<
	Status,
	{ dot: string; text: string; label: string }
> = {
	running: {
		dot: "bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/20",
		text: "text-emerald-600 dark:text-emerald-400",
		label: "Running",
	},
	partial: {
		dot: "bg-amber-500 shadow-[0_0_0_3px] shadow-amber-500/20",
		text: "text-amber-600 dark:text-amber-400",
		label: "Partially running",
	},
	error: {
		dot: "bg-red-500 shadow-[0_0_0_3px] shadow-red-500/20",
		text: "text-red-600 dark:text-red-400",
		label: "Error",
	},
	invalid: {
		dot: "bg-red-500",
		text: "text-red-600 dark:text-red-400",
		label: "Invalid config",
	},
	stopped: {
		dot: "border border-zinc-400 dark:border-zinc-500",
		text: "text-zinc-500 dark:text-zinc-400",
		label: "Stopped",
	},
	unknown: {
		dot: "bg-zinc-300 dark:bg-zinc-600",
		text: "text-zinc-500 dark:text-zinc-400",
		label: "Unknown",
	},
};

export function StatusDot({ status }: { status: Status }) {
	return (
		<span
			aria-hidden
			className={`inline-block size-2 shrink-0 rounded-full ${statusStyles[status].dot}`}
		/>
	);
}

export function StatusLabel({ status }: { status: Status }) {
	const s = statusStyles[status];
	return (
		<span
			className={`inline-flex items-center gap-2 text-sm font-medium ${s.text}`}
		>
			<StatusDot status={status} />
			{s.label}
		</span>
	);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "primary" | "secondary" | "ghost" | "danger";
	size?: "sm" | "md";
	pending?: boolean;
};

export function Button({
	variant = "secondary",
	size = "md",
	pending,
	className = "",
	children,
	disabled,
	...rest
}: ButtonProps) {
	const variants = {
		primary:
			"bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
		secondary:
			"border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
		ghost:
			"text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
		danger:
			"border border-red-200 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950",
	};
	const sizes = { sm: "h-7 px-2.5 text-xs", md: "h-8 px-3 text-sm" };
	return (
		<button
			type="button"
			disabled={disabled || pending}
			className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
			{...rest}
		>
			{pending && (
				<span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
			)}
			{children}
		</button>
	);
}

export function ExternalLink({
	href,
	children,
	className = "",
}: {
	href: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className={`inline-flex h-7 items-center gap-1 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 ${className}`}
		>
			{children}
			<span aria-hidden className="text-zinc-400">
				{"↗\uFE0E"}
			</span>
		</a>
	);
}

export function Card({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={`rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
		>
			{children}
		</div>
	);
}

export function Section({
	title,
	actions,
	children,
}: {
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
					{title}
				</h2>
				{actions}
			</div>
			{children}
		</section>
	);
}

export function Mono({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<code className={`font-mono text-[0.8125rem] ${className}`}>
			{children}
		</code>
	);
}

export function CopyButton({
	value,
	label = "Copy",
}: {
	value: string;
	label?: string;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size="sm"
			variant="ghost"
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			{copied ? "Copied" : label}
		</Button>
	);
}

export function ErrorBanner({
	error,
	onDismiss,
}: {
	error: string | null;
	onDismiss?: () => void;
}) {
	if (!error) return null;
	return (
		<div className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
			<span className="break-words">{error}</span>
			{onDismiss && (
				<button
					type="button"
					onClick={onDismiss}
					className="shrink-0 opacity-60 hover:opacity-100"
					aria-label="Dismiss"
				>
					✕
				</button>
			)}
		</div>
	);
}

/** Re-runs route loaders on an interval while the tab is visible. */
export function useAutoRefresh(ms = 3000) {
	const router = useRouter();
	useEffect(() => {
		const id = setInterval(() => {
			// A refresh cut short by navigation or a hub restart is harmless.
			if (document.visibilityState === "visible")
				router.invalidate().catch(() => {});
		}, ms);
		return () => clearInterval(id);
	}, [router, ms]);
}

/**
 * Wraps a server-function call with pending/error state and refreshes the
 * route data afterwards, so status updates as soon as a command finishes.
 */
export function useAction() {
	const router = useRouter();
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = useCallback(
		async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
			setPending(key);
			setError(null);
			try {
				return await fn();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return undefined;
			} finally {
				setPending(null);
				router.invalidate().catch(() => {});
			}
		},
		[router],
	);
	return { run, pending, error, clearError: () => setError(null) };
}
