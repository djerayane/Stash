# Standardize the web and mobile client stack

Stash uses a TypeScript monorepo managed with pnpm workspaces. The primary clients live in `apps/web` and `apps/mobile`; focused shared packages contain domain types, API clients, validation, synchronization logic, and CSS design tokens where applicable. Server and domain packages remain independent of client frameworks.

The web application uses React 19, Vite, React Router, and TanStack Query. Member-facing interfaces use Radix primitives, CSS Modules, and shared CSS design tokens. Note authoring uses Tiptap and ProseMirror with Yjs, connected to a self-hosted collaboration service owned by the Stash Instance. Server-rendered HTML and imperative DOM scripts are transitional migration surfaces and cannot satisfy acceptance for a Member-facing capability.

The mobile application uses Expo and React Native. It shares domain types, API clients, validation, and synchronization logic with the web client, but retains native screens, controls, interaction patterns, and accessibility behavior rather than sharing most UI components.

Client unit and integration tests use Vitest and Testing Library. Browser acceptance uses Playwright against a running Stash Instance, with axe checks and explicit keyboard, focus, error-recovery, and reduced-motion coverage. Server packages may retain focused server-side tests, but server protocol tests do not substitute for browser acceptance of a Member-facing capability.

This decision supersedes any implementation direction inferred from the initial minimal operator page. ADR-0013 continues to define web and mobile as the primary clients; this ADR fixes their implementation architecture.
