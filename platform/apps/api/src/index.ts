// REST API for the CLI (NestJS). See design/D-03 section 5.1 and ADR-M26.
export { createApp, type ApiDeps } from './app.js';
export { API_ERROR_CODES, ApiError, type ApiErrorCode } from './errors/api-error.js';
export { API_ENV, loadSettings, SettingsError, type ApiSettings } from './settings.js';
