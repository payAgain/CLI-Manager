// Pure OSC (Operating System Command) sequence parsing for the terminal stream.
// No React or xterm runtime dependency — these operate on raw strings only.
// The stateful scanning (carry buffers) and side-effect dispatch (cwd updates,
// runtime events, color replies) stay in XTermTerminal; only the pure matchers
// and formatters live here so they can be tested in isolation.

import { decodeOscPathValue } from "./terminalOscPath";
import { normalizeHexColor } from "./terminalColor";

export const LEGACY_RUNTIME_OSC_PREFIX = "\x1b]777;cli-manager;";
export const CWD_OSC_PREFIX = "\x1b]7;";
export const INTEGRATION_OSC_PREFIXES = ["\x1b]133;", "\x1b]633;", CWD_OSC_PREFIX, LEGACY_RUNTIME_OSC_PREFIX];
export const OSC_PREFIX = "\x1b]";

export type SpecialColorQueryId = 10 | 11;

export type OscPrefixMatch =
  | { kind: "match"; prefix: string }
  | { kind: "partial" }
  | { kind: "none" };

// Terminator: BEL or ST (ESC \). null means the sequence is not yet complete
// (spans chunks, needs buffering).
export type OscTerminator = { index: number; length: number } | { abortAt: number } | null;

export function parseStandardIntegrationCwd(command: string, rest: string): string | null {
  if (command !== "P") return null;
  const field = rest.split(";").find((part) => part.toLocaleLowerCase().startsWith("cwd="));
  if (!field) return null;
  const value = decodeOscPathValue(field.slice(field.indexOf("=") + 1)).trim();
  return value || null;
}

export const matchIntegrationOscPrefix = (text: string, start: number): OscPrefixMatch => {
  let partial = false;
  for (const prefix of INTEGRATION_OSC_PREFIXES) {
    const available = Math.min(prefix.length, text.length - start);
    if (text.startsWith(prefix.slice(0, available), start)) {
      if (available === prefix.length) return { kind: "match", prefix };
      partial = true;
    }
  }
  return partial ? { kind: "partial" } : { kind: "none" };
};

export const findOscTerminator = (text: string, from: number): OscTerminator => {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x07) return { index: i, length: 1 };
    if (code === 0x1b) {
      if (i + 1 >= text.length) return null;
      if (text[i + 1] === "\\") return { index: i, length: 2 };
      // A bare ESC should not appear inside an OSC body; treat it as an invalid
      // sequence and pass it through rather than swallowing normal output.
      return { abortAt: i };
    }
  }
  return null;
};

export const parseSpecialColorQuery = (body: string): SpecialColorQueryId | null => {
  const separator = body.indexOf(";");
  if (separator < 0) return null;
  const oscId = body.slice(0, separator);
  const payload = body.slice(separator + 1).trim();
  if (payload !== "?") return null;
  if (oscId === "10") return 10;
  if (oscId === "11") return 11;
  return null;
};

export const formatSpecialColorReply = (queryId: SpecialColorQueryId, hex: string) => {
  const normalized = normalizeHexColor(hex, queryId === 10 ? "#d8dee9" : "#0c0e10");
  const r = normalized.slice(1, 3);
  const g = normalized.slice(3, 5);
  const b = normalized.slice(5, 7);
  return `${OSC_PREFIX}${queryId};rgb:${r}${r}/${g}${g}/${b}${b}\x1b\\`;
};
