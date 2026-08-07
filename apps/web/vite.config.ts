/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"] },
  server: { proxy: { "/v1": { target: "http://127.0.0.1:3000", changeOrigin: false } } },
});
