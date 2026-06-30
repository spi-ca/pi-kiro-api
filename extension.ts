import { filterModelsByRegion, kiroModels } from "./src/kiro/models.ts";
import { streamKiro } from "./src/kiro/stream.ts";

const PROVIDER_ID = "kiro-api-key";
const DEFAULT_REGION = "us-east-1";

function getRegion(): string {
  const raw = globalThis.process?.env?.KIRO_API_REGION;
  const region = typeof raw === "string" ? raw.trim() : "";
  return region || DEFAULT_REGION;
}

function getModelsForRegion(region: string, baseUrl: string) {
  const regionalModels = filterModelsByRegion(kiroModels, region);
  const models = regionalModels.length > 0 ? regionalModels : kiroModels;
  return models.map((model) => ({ ...model, baseUrl }));
}

// pi passes an ExtensionAPI here. Typed loosely so the package has no build
// step — pi loads this .ts file directly via jiti.
export default function registerKiroApiKeyProvider(pi: {
  registerProvider: (id: string, config: unknown) => void;
}): void {
  const region = getRegion();
  const baseUrl = `https://q.${region}.amazonaws.com/`;

  pi.registerProvider(PROVIDER_ID, {
    name: "Kiro (API Key)",
    baseUrl,
    apiKey: "$KIRO_API_KEY",
    api: "kiro-api",
    models: getModelsForRegion(region, baseUrl),
    streamSimple: streamKiro,
  });
}
