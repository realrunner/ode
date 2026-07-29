import type { Elysia } from "elysia";
import {
  discoverDiscordWorkspace,
  discoverLarkWorkspace,
  discoverSlackWorkspace,
  syncDiscordWorkspace,
  syncLarkWorkspace,
  syncSlackWorkspace,
} from "../local-settings";
import { jsonResponse, readJsonBody, runRoute } from "../http";

type WorkspaceRouteSpec = {
  path: string;
  fallbackMessage: string;
  resolveStatus: (message: string) => number;
  run: (payload: Record<string, unknown>) => Promise<unknown>;
};

function getString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function getWorkspaceId(payload: Record<string, unknown>): string {
  const workspaceId = getString(payload, "workspaceId");
  if (!workspaceId) {
    throw new Error("Missing workspaceId");
  }
  return workspaceId;
}

function registerWorkspaceRoute(app: Elysia, spec: WorkspaceRouteSpec): void {
  app.post(spec.path, async ({ request }: { request: Request }) => {
    return runRoute(
      async () => spec.run(await readJsonBody(request)),
      (workspace) => jsonResponse(200, { ok: true, workspace }),
      {
        fallbackMessage: spec.fallbackMessage,
        resolveStatus: spec.resolveStatus,
      }
    );
  });
}

const WORKSPACE_ROUTES: WorkspaceRouteSpec[] = [
  {
    path: "/api/slack-sync",
    fallbackMessage: "Slack sync failed",
    resolveStatus: (message) => (message === "Missing workspaceId" ? 400 : 500),
    run: async (payload) => syncSlackWorkspace(getWorkspaceId(payload)),
  },
  {
    path: "/api/discord-sync",
    fallbackMessage: "Discord sync failed",
    resolveStatus: (message) => (message === "Missing workspaceId" ? 400 : 500),
    run: async (payload) => syncDiscordWorkspace(getWorkspaceId(payload)),
  },
  {
    path: "/api/lark-sync",
    fallbackMessage: "Lark sync failed",
    resolveStatus: (message) => (message === "Missing workspaceId" ? 400 : 500),
    run: async (payload) => syncLarkWorkspace(getWorkspaceId(payload)),
  },
  {
    path: "/api/slack-discover",
    fallbackMessage: "Slack workspace discovery failed",
    resolveStatus: (message) => message.startsWith("Missing Slack")
      ? 400
      : message.includes("rate limited")
        ? 429
        : 500,
    run: async (payload) => discoverSlackWorkspace(
      getString(payload, "slackAppToken"),
      getString(payload, "slackBotToken")
    ),
  },
  {
    path: "/api/discord-discover",
    fallbackMessage: "Discord workspace discovery failed",
    resolveStatus: (message) => (message.startsWith("Missing Discord") ? 400 : 500),
    run: async (payload) => discoverDiscordWorkspace(getString(payload, "discordBotToken")),
  },
  {
    path: "/api/lark-discover",
    fallbackMessage: "Lark workspace discovery failed",
    resolveStatus: (message) => (message.startsWith("Missing Lark") ? 400 : 500),
    run: async (payload) => {
      const larkAppKey = getString(payload, "larkAppKey") || getString(payload, "larkAppId");
      return discoverLarkWorkspace(larkAppKey, getString(payload, "larkAppSecret"));
    },
  },
];

export function registerWorkspaceRoutes(app: Elysia): void {
  for (const spec of WORKSPACE_ROUTES) {
    registerWorkspaceRoute(app, spec);
  }
}
