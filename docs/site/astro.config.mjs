// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://bubblegunn.github.io",
  base: "/proactive-gate",
  integrations: [
    starlight({
      title: "proactive-gate",
      description: "Decide whether a proactive AI agent may reach a user right now, and log why not.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Bubblegunn/proactive-gate" }],
      editLink: { baseUrl: "https://github.com/Bubblegunn/proactive-gate/edit/main/docs/site/" },
      sidebar: [
        { label: "Start", slug: "start" },
        { label: "Decisions", slug: "decisions" },
        { label: "Checks", slug: "checks" },
        { label: "Policy as data", slug: "policy" },
        { label: "Presets", slug: "presets" },
        { label: "Adapters", slug: "adapters" },
        { label: "Python", slug: "python" },
        { label: "Spec and conformance", slug: "spec" },
        { label: "Playground", link: "/playground/" },
      ],
      plugins: [starlightLlmsTxt()],
    }),
  ],
});
