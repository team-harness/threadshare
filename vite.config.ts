import { defineConfig } from "vite";
import { voidPlugin } from "void";

export default defineConfig(({ mode }) => ({
  plugins: mode === "cloudflare" ? [] : [voidPlugin()],
  // Embedded WebViews may predate media-query range syntax.
  build: { cssTarget: "chrome87" },
}));
