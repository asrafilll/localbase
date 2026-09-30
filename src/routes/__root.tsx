import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	HeadContent,
	Link,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: "Local Dev Hub" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{
				rel: "icon",
				href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2318181b'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%2310b981'/%3E%3C/svg%3E",
			},
		],
	}),
	shellComponent: RootDocument,
	notFoundComponent: () => (
		<p className="text-sm text-zinc-500">Page not found.</p>
	),
	errorComponent: ({ error }) => (
		<div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
			{error instanceof Error ? error.message : String(error)}
		</div>
	),
});

function NavLink({ to, children }: { to: string; children: ReactNode }) {
	return (
		<Link
			to={to}
			activeOptions={{ exact: to === "/" }}
			className="rounded-md px-2.5 py-1.5 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
			activeProps={{
				className:
					"bg-zinc-100 font-medium !text-zinc-900 dark:bg-zinc-800 dark:!text-zinc-100",
			}}
		>
			{children}
		</Link>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body className="bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
				<header className="sticky top-0 z-20 border-b border-zinc-200 bg-zinc-50/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
					<div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
						<Link to="/" className="flex items-center gap-2 font-semibold">
							<span className="grid size-6 place-items-center rounded-md bg-zinc-900 font-mono text-xs text-white dark:bg-zinc-100 dark:text-zinc-900">
								⌂
							</span>
							Local Dev Hub
						</Link>
						<nav className="flex items-center gap-1">
							<NavLink to="/">Projects</NavLink>
							<NavLink to="/ports">Ports</NavLink>
							<NavLink to="/settings">Settings</NavLink>
						</nav>
					</div>
				</header>
				<main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{ position: "bottom-right" }}
						plugins={[
							{
								name: "Tanstack Router",
								render: <TanStackRouterDevtoolsPanel />,
							},
						]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}
