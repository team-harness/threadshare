import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig(({ mode }) => ({
  plugins: mode === "cloudflare" ? [] : [voidPlugin()],
}));
