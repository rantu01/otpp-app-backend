'use strict';
/**
 * Central backend/API URL configuration.
 *
 * Single place to change the public base URL in the future — clients
 * (Android user app + admin app) centralize on this same value via their
 * own ApiConfig/ApiDefaults. Backend itself reads PUBLIC_BASE_URL first so
 * deploys can override without code changes.
 */
const DEFAULT_API_BASE_URL = 'https://otp.rantumondal.dev';

function getPublicBaseUrl() {
  const env = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  return DEFAULT_API_BASE_URL;
}

module.exports = { DEFAULT_API_BASE_URL, getPublicBaseUrl };
