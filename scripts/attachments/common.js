const path = require('path');
const { CliError } = require('../errors');

const DEFAULT_MAX_AGE_MINUTES = 60;
const SESSION_ID_PATTERN = /^(?:ses_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f-]{27,})$/i;
const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]+$/;
const PART_ID_PATTERN = /^prt_[A-Za-z0-9]+$/;

function fail(code, message, exitCode = 1) {
  throw new CliError(code, message, exitCode);
}

function normalizedDirectory(value, platform = process.platform) {
  if (!value) return '';
  let normalized = path.resolve(String(value)).replace(/[\\/]+$/, '');
  if (platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function directoriesMatch(left, right, platform = process.platform) {
  return normalizedDirectory(left, platform) === normalizedDirectory(right, platform);
}

module.exports = {
  DEFAULT_MAX_AGE_MINUTES,
  MESSAGE_ID_PATTERN,
  PART_ID_PATTERN,
  SESSION_ID_PATTERN,
  directoriesMatch,
  fail,
  normalizedDirectory,
};
