/**
 * Simple timestamped logging.
 */

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

export function info(msg) {
  console.log(`[${ts()}] ${msg}`);
}

export function warn(msg) {
  console.warn(`[${ts()}] WARN: ${msg}`);
}

export function error(msg, detail = '') {
  console.error(`[${ts()}] ERROR: ${msg}${detail ? ' — ' + detail : ''}`);
}

export function stat(label, value) {
  console.log(`[${ts()}]   ${label}: ${value}`);
}
