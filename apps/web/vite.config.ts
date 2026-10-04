import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const server = process.env["GP_SERVER_URL"] ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API server runs separately in development; the browser talks to Vite only.
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
      // AI access (MCP): the endpoint and its OAuth sign-in
      "/mcp": { target: server, changeOrigin: false },
      "/oauth": { target: server, changeOrigin: false },
      "/.well-known/oauth-": { target: server, changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    css: false,
  },
});
