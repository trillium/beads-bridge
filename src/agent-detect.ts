// Web-agent detection: serve raw text/JSON to fetchers, HTML UI to browsers.
// ChatGPT fetches as "ChatGPT-User/1.0"; browsers send Mozilla + Accept: text/html.
const AGENT_UA = /chatgpt-user|gptbot|claude-web|claudebot|anthropic|perplexity|cohere|diffbot|fetch/i;

export function isWebAgent(userAgent: string | undefined, accept: string | undefined): boolean {
  const ua = userAgent ?? '';
  if (AGENT_UA.test(ua)) return true;
  // No browser markers at all (curl, scripts) → treat as agent.
  if (!/mozilla|webkit|gecko|chrome|safari|firefox|edge/i.test(ua)) return true;
  // Browser UA but explicitly asking for non-HTML → agent-like fetch.
  if (accept && !accept.includes('text/html')) return true;
  return false;
}
