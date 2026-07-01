import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BC Assistant",
    short_name: "BC Chat",
    description:
      "AI assistant for Choco Delight and Saurabh Food Business Central — customers, sales, inventory, and reports.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fafafa",
    theme_color: "#18181b",
    categories: ["business", "finance", "productivity"],
  };
}
