// The `argument` field of POST /scanpro/v1/start is the same base64-encoded JSON launch
// payload the browser hands over through the custom URL scheme — the local HTTP service is
// just a second transport for it. So decoding reuses the launch-URL parser, and everything
// downstream (field extraction, the flow, the UI) is unchanged.

import { Buffer } from 'node:buffer';

import { parseLaunchUrl } from '../payload.js';

// Base64 that decodes to binary makes the underlying JSON error quote raw bytes. That noise
// ends up in an HTTP response, so keep only printable ASCII and cap the length.
function cleanReason(message) {
  const printable = String(message).replace(/[^\x20-\x7E]+/g, '?');
  return printable.length > 160 ? `${printable.slice(0, 157)}...` : printable;
}

/**
 * Decode the base64 JSON `argument` of a /start request.
 * @param {string} argument
 * @returns {object} the decoded launch payload
 * @throws {Error} with a message naming `argument`, so a 400 tells the caller what to fix
 */
export function decodeArgument(argument) {
  let payload;
  try {
    payload = parseLaunchUrl(argument);
  } catch (err) {
    throw new Error(`\`argument\` is not a base64-encoded JSON object: ${cleanReason(err.message)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('`argument` must decode to a JSON object');
  }
  return payload;
}

/** Encode a launch payload the way a caller must send it. Used by the docs' curl examples. */
export function encodeArgument(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** One-line summary of a decoded payload, for logs and the UI. Never throws. */
export function summarizeArgument(decoded) {
  if (!decoded || typeof decoded !== 'object') return '(not an object)';
  const parts = [];
  const caller = decoded.caller?.name;
  if (caller) parts.push(`caller=${caller}`);
  const caseId = decoded.case?.ID ?? decoded.case?.Id ?? decoded.case?.id;
  if (caseId) parts.push(`case=${caseId}`);
  if (decoded.treatmentId) parts.push(`treatmentId=${decoded.treatmentId}`);
  const teeth = decoded.treatment?.teeth;
  if (Array.isArray(teeth)) parts.push(`teeth=${teeth.length}`);
  if (decoded.language) parts.push(`language=${decoded.language}`);
  return parts.length > 0 ? parts.join(' ') : '(no recognized fields)';
}
