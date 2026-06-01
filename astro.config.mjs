import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import vercel from "@astrojs/vercel/serverless";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    output: "server",
    adapter: vercel(),
    integrations: [react()],
    vite: {
        plugins: [tailwindcss()],
    },
});
