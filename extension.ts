import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { createKiroProvider } from "./src/kiro/provider-auth.ts";

/**
 * Pi awaits async extension factories before native provider registration is
 * flushed. A successful ambient discovery installs a catalog before
 * `pi --list-models` inspects the provider; an ambient failure is non-fatal so
 * Pi can continue with native stored-credential resolution.
 */
export default async function registerKiroApiKeyProvider(pi: ExtensionAPI): Promise<void> {
  const provider = createKiroProvider();
  await provider.preloadAmbientCatalog();
  pi.registerProvider(provider);
  registerApiProvider(
    {
      api: "kiro-api",
      stream: (model, context, options) =>
        provider.stream(model, context, options as Parameters<typeof provider.stream>[2]),
      streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
    },
    provider.id,
  );

  // pi-blackhole runs consolidation agents through jiti, which can observe a
  // separate pi-ai compat registry. Populate its shared bridge as well so those
  // agents can still dispatch Kiro requests through the native provider stream.
  const providerStreams: Map<string, Function> | undefined = (globalThis as Record<symbol, unknown>)[
    Symbol.for("pi-blackhole:provider-streams")
  ] as Map<string, Function> | undefined;
  providerStreams?.set("kiro-api", provider.streamSimple);
}
