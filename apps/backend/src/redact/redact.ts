const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Requires 4+ colon-separated groups (5+ segments) so HH:MM:SS timestamps
// (3 segments) never match; real IPv6 addresses in Minecraft's connection
// logging have far more segments than a clock does.
const IPV6_PATTERN = /\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b/g;

/**
 * Defense-in-depth redaction, applied unconditionally at ingest time regardless
 * of server-side log settings. Minecraft logs IPs in connection/disconnect lines
 * (e.g. "logged in with entity id ... at (...)" can include /ip:port for the socket).
 */
export function redactLine(rawText: string): string {
  return rawText.replace(IPV4_PATTERN, "[IP]").replace(IPV6_PATTERN, "[IP]");
}
