/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // edge-gateway; buffering is disabled by http-proxy for text/event-stream
      "/v1": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
  preview: {
    proxy: {
      "/v1": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
