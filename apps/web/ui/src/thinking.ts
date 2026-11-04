import type { ModelRoute } from "./lib/rpc.ts";

interface ReasoningInfo {
  levels?: string[];
  models?: {
    models: Array<{
      provider: string;
      model: string;
      reasoning_efforts: string[];
    }>;
  } | null;
}

export function reasoningFallback(
  info: ReasoningInfo | null,
  route: ModelRoute | null,
  thinking: string,
): string | null {
  if (info === null || route === null || thinking === "off") return null;
  const selected = info.models?.models.find(
    (model) => model.provider === route.provider && model.model === route.model,
  );
  if (selected === undefined || selected.reasoning_efforts.includes(thinking)) return null;
  return (info.levels ?? []).find(
    (level) => level !== "off" && selected.reasoning_efforts.includes(level),
  ) ?? "off";
}
