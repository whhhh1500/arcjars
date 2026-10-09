import { defineConfig } from "vite";
// Relative base so the static build works on GitHub Pages (any repo name) and IPFS.
export default defineConfig({ base: "./", build: { target: "es2022" } });
