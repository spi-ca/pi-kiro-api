import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
}
