// Container health check (docker-compose.yml, service sdlc-api): exit 0 when /health/ready answers.
const port = process.env.SDLC_API_PORT ?? '8080';

fetch(`http://127.0.0.1:${port}/health/ready`, { signal: AbortSignal.timeout(4000) }).then(
  (response) => process.exit(response.ok ? 0 : 1),
  () => process.exit(1),
);
