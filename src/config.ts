import { internal } from "varlock";
const keys = ["ANTHROPIC_API_KEY", "WHISPER_MODEL", "WHISPER_BINARY", "CLAUDE_MODEL"];
export async function resolveCLIConfig(
  basePath = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    // Use the graph API rather than load(), which serializes secrets into process.env.
    const graph = await internal.loadEnvGraph({
      basePath,
      skipCache: true,
      overrideValues: env,
      processEnvOverride: env,
    });
    await graph.resolveEnvValues(keys);
    if (
      graph.sortedDataSources.some(
        (source) => source.schemaErrors.length || source.resolutionErrors.length,
      ) ||
      keys.some((key) => !graph.configSchema[key]?.isValid)
    )
      throw new Error("Invalid configuration");
    const value = (key: string): string => {
      const resolved = graph.configSchema[key]?.resolvedValue;
      if (typeof resolved !== "string") throw new Error("Invalid configuration value");
      return resolved;
    };
    return {
      apiKey: value("ANTHROPIC_API_KEY"),
      env: {
        WHISPER_MODEL: value("WHISPER_MODEL"),
        WHISPER_BINARY: value("WHISPER_BINARY"),
        CLAUDE_MODEL: value("CLAUDE_MODEL"),
      },
    };
  } catch {
    throw new Error(
      "Could not resolve CLI configuration through Varlock. Check .env.schema, .env.local and your 1Password account access.",
    );
  }
}
