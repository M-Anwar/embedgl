import { defineConfig } from "vite";

export default defineConfig({
    build: {
        outDir: "src/embedgl/static",
        emptyOutDir: true,
        lib: {
            entry: "frontend/index.tsx",
            formats: ["es"],
            fileName: () => "widget.js",
            cssFileName: "widget",
        },
        minify: true,
    },
    worker: { format: "es" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
});