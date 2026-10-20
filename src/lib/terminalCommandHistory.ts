export const COMMAND_HISTORY_OSC_PREFIX = "\x1b]777;cli-manager-history;";

export function parseTerminalCommandHistory(body: string, sessionId: string): { command: string; eventId: string } | null {
  const fields = body.split(";");
  if (fields.length !== 3 || fields[0] !== sessionId || !/^\d+-\d+$/u.test(fields[1])) return null;
  if (fields[2].length > 22000 || !/^[A-Za-z\d+/]*={0,2}$/u.test(fields[2])) return null;
  try {
    const bytes = Uint8Array.from(atob(fields[2]), (character) => character.charCodeAt(0));
    const command = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { command, eventId: `${sessionId}:${fields[1]}` };
  } catch {
    return null;
  }
}

/** Keep replay provenance before any of the display filters buffer OSC bytes. */
export function createTerminalCommandHistoryReader(sessionId: string, onCommand: (command: string, eventId: string) => void) {
  let carry = "";
  let carryLive = false;
  return (text: string, live: boolean) => {
    const previousLength = carry.length;
    const previousLive = carryLive;
    const combined = carry + text;
    carry = "";
    let cursor = 0;
    while (cursor < combined.length) {
      const start = combined.indexOf(COMMAND_HISTORY_OSC_PREFIX, cursor);
      if (start < 0) {
        for (let length = Math.min(COMMAND_HISTORY_OSC_PREFIX.length - 1, combined.length - cursor); length > 0; length--) {
          if (combined.endsWith(COMMAND_HISTORY_OSC_PREFIX.slice(0, length))) {
            carry = combined.slice(-length);
            carryLive = live && (combined.length - length >= previousLength || previousLive);
            break;
          }
        }
        break;
      }
      const bodyStart = start + COMMAND_HISTORY_OSC_PREFIX.length;
      const terminator = /\x07|\x1b\\/gu;
      terminator.lastIndex = bodyStart;
      const end = terminator.exec(combined);
      const recordable = live && (start >= previousLength || previousLive);
      if (!end) {
        if (combined.length - start <= 24 * 1024) {
          carry = combined.slice(start);
          carryLive = recordable;
        }
        break;
      }
      if (recordable) {
        const entry = parseTerminalCommandHistory(combined.slice(bodyStart, end.index), sessionId);
        if (entry) onCommand(entry.command, entry.eventId);
      }
      cursor = end.index + end[0].length;
    }
  };
}
