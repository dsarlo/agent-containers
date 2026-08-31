export function isLiveIntegrationEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.AGENT_CONTAINERS_REQUIRE_LIVE_INTEGRATION === '1';
}
