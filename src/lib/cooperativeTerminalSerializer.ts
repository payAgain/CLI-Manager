/**
 * Cooperative adaptation of @xterm/addon-serialize 0.15.0-beta.288,
 * upstream commit 8aab310366549d8d865bd8fc4bd509051f2bb2a1 (xterm 6.1.0-beta.288).
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * The string state machine below preserves upstream's ANSI/cursor/wrap rules.
 * Changes: row/cell/assembly yields, cancellation and a resumable synchronous finish.
 * Keep equivalence tests against the installed addon when upgrading xterm.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { IBuffer, IBufferCell, IBufferRange, Terminal } from "@xterm/xterm";
import type { ISerializeOptions, ISerializeRange } from "@xterm/addon-serialize";

// Only these upstream enum values are used by its string serializer.
const UnderlineStyle = { NONE: 0, SINGLE: 1 } as const;
// The current cursor attributes expose the same attribute methods as a cell.
// The serializer never reads character/width methods from this object.
type IAttributeData = IBufferCell;

function constrain(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

abstract class BaseSerializeHandler {
  constructor(
    protected readonly _buffer: IBuffer
  ) {
  }

  public *serialize(range: IBufferRange, excludeFinalCursorPosition?: boolean): Generator<void, string> {
    // we need two of them to flip between old and new cell
    const cell1 = this._buffer.getNullCell();
    const cell2 = this._buffer.getNullCell();
    let oldCell = cell1;

    const startRow = range.start.y;
    const endRow = range.end.y;
    const startColumn = range.start.x;
    const endColumn = range.end.x;

    this._beforeSerialize(endRow - startRow, startRow, endRow);

    for (let row = startRow; row <= endRow; row++) {
      const line = this._buffer.getLine(row);
      if (line) {
        const startLineColumn = row === range.start.y ? startColumn : 0;
        const endLineColumn = row === range.end.y ? endColumn: line.length;
        for (let col = startLineColumn; col < endLineColumn; col++) {
          const c = line.getCell(col, oldCell === cell1 ? cell2 : cell1);
          if (!c) {
            console.warn(`Can't get cell at row=${row}, col=${col}`);
            continue;
          }
          this._nextCell(c, oldCell, row, col);
          oldCell = c;
          // Keep exceptionally wide terminal rows cooperative as well.
          if ((col - startLineColumn + 1) % 256 === 0) yield;
        }
      }
      this._rowEnd(row, row === endRow);
      yield;
    }

    this._afterSerialize();

    return yield* this._serializeString(excludeFinalCursorPosition);
  }

  protected _nextCell(_cell: IBufferCell, _oldCell: IBufferCell, _row: number, _col: number): void { }
  protected _rowEnd(_row: number, _isLastRow: boolean): void { }
  protected _beforeSerialize(_rows: number, _startRow: number, _endRow: number): void { }
  protected _afterSerialize(): void { }
  protected *_serializeString(_excludeFinalCursorPosition?: boolean): Generator<void, string> { return ''; }
}

function equalFg(cell1: IBufferCell | IAttributeData, cell2: IBufferCell): boolean {
  return cell1.getFgColorMode() === cell2.getFgColorMode()
    && cell1.getFgColor() === cell2.getFgColor();
}

function equalBg(cell1: IBufferCell | IAttributeData, cell2: IBufferCell): boolean {
  return cell1.getBgColorMode() === cell2.getBgColorMode()
    && cell1.getBgColor() === cell2.getBgColor();
}

function equalUnderline(cell1: IBufferCell | IAttributeData, cell2: IBufferCell): boolean {
  // If neither cell has underline, consider them equal regardless of internal underline color
  // values
  if (!cell1.isUnderline() && !cell2.isUnderline()) {
    return true;
  }
  if (cell1.getUnderlineStyle() !== cell2.getUnderlineStyle()) {
    return false;
  }
  const cell1Default = cell1.isUnderlineColorDefault();
  const cell2Default = cell2.isUnderlineColorDefault();
  if (cell1Default && cell2Default) {
    return true;
  }
  if (cell1Default !== cell2Default) {
    return false;
  }
  return cell1.getUnderlineColor() === cell2.getUnderlineColor()
    && cell1.getUnderlineColorMode() === cell2.getUnderlineColorMode();
}

function equalFlags(cell1: IBufferCell | IAttributeData, cell2: IBufferCell): boolean {
  return cell1.isInverse() === cell2.isInverse()
    && cell1.isBold() === cell2.isBold()
    && cell1.isUnderline() === cell2.isUnderline()
    && equalUnderline(cell1, cell2)
    && cell1.isOverline() === cell2.isOverline()
    && cell1.isBlink() === cell2.isBlink()
    && cell1.isInvisible() === cell2.isInvisible()
    && cell1.isItalic() === cell2.isItalic()
    && cell1.isDim() === cell2.isDim()
    && cell1.isStrikethrough() === cell2.isStrikethrough();
}

function attributesEquals(cell1: IBufferCell | IAttributeData, cell2: IBufferCell): boolean {
  const cell1AsBufferCell = cell1 as IBufferCell;
  if (typeof cell1AsBufferCell.attributesEquals === 'function') {
    return cell1AsBufferCell.attributesEquals(cell2);
  }
  return equalFg(cell1, cell2)
    && equalBg(cell1, cell2)
    && equalFlags(cell1, cell2);
}

class StringSerializeHandler extends BaseSerializeHandler {
  private _rowIndex: number = 0;
  private _allRows: string[] = new Array<string>();
  private _allRowSeparators: string[] = new Array<string>();
  private _currentRow: string = '';
  private _nullCellCount: number = 0;

  // we can see a full colored cell and a null cell that only have background the same style
  // but the information isn't preserved by null cell itself
  // so wee need to record it when required.
  private _cursorStyle: IBufferCell = this._buffer.getNullCell();

  // where exact the cursor styles comes from
  // because we can't copy the cell directly
  // so we remember where the content comes from instead
  private _cursorStyleRow: number = 0;
  private _cursorStyleCol: number = 0;

  // this is a null cell for reference for checking whether background is empty or not
  private _backgroundCell: IBufferCell = this._buffer.getNullCell();

  private _firstRow: number = 0;
  private _lastCursorRow: number = 0;
  private _lastCursorCol: number = 0;
  private _lastContentCursorRow: number = 0;
  private _lastContentCursorCol: number = 0;

  constructor(
    buffer: IBuffer,
    private readonly _terminal: Terminal
  ) {
    super(buffer);
  }

  protected _beforeSerialize(rows: number, start: number, _end: number): void {
    this._allRows = new Array<string>(rows);
    this._lastContentCursorRow = start;
    this._lastCursorRow = start;
    this._firstRow = start;
  }

  private _thisRowLastChar: IBufferCell = this._buffer.getNullCell();
  private _thisRowLastSecondChar: IBufferCell = this._buffer.getNullCell();
  private _nextRowFirstChar: IBufferCell = this._buffer.getNullCell();
  protected _rowEnd(row: number, isLastRow: boolean): void {
    // if there is colorful empty cell at line end, we must pad it back, or the color block
    // will missing
    if (this._nullCellCount > 0 && !equalBg(this._cursorStyle, this._backgroundCell)) {
      // use clear right to set background.
      this._currentRow += `\u001b[${this._nullCellCount}X`;
    }

    let rowSeparator = '';

    // handle row separator
    if (!isLastRow) {
      // Enable BCE
      if (row - this._firstRow >= this._terminal.rows) {
        this._buffer.getLine(this._cursorStyleRow)?.getCell(this._cursorStyleCol, this._backgroundCell);
      }

      // Fetch current line
      const currentLine = this._buffer.getLine(row)!;
      // Fetch next line
      const nextLine = this._buffer.getLine(row + 1)!;

      if (!nextLine.isWrapped) {
        // just insert the line break
        rowSeparator = '\r\n';
        // we sended the enter
        this._lastCursorRow = row + 1;
        this._lastCursorCol = 0;
      } else {
        rowSeparator = '';
        const thisRowLastChar = currentLine.getCell(currentLine.length - 1, this._thisRowLastChar)!;
        const thisRowLastSecondChar = currentLine.getCell(currentLine.length - 2, this._thisRowLastSecondChar)!;
        const nextRowFirstChar = nextLine.getCell(0, this._nextRowFirstChar)!;
        const isNextRowFirstCharDoubleWidth = nextRowFirstChar.getWidth() > 1;

        // validate whether this line wrap is ever possible
        // which mean whether cursor can placed at a overflow position (x === row) naturally
        let isValid = false;

        if (
          // you must output character to cause overflow, control sequence can't do this
          nextRowFirstChar.getChars() &&
            isNextRowFirstCharDoubleWidth ? this._nullCellCount <= 1 : this._nullCellCount <= 0
        ) {
          if (
            // the last character can't be null,
            // you can't use control sequence to move cursor to (x === row)
            (thisRowLastChar.getChars() || thisRowLastChar.getWidth() === 0) &&
            // change background of the first wrapped cell also affects BCE
            // so we mark it as invalid to simplify the process to determine line separator
            equalBg(thisRowLastChar, nextRowFirstChar)
          ) {
            isValid = true;
          }

          if (
            // the second to last character can't be null if the next line starts with CJK,
            // you can't use control sequence to move cursor to (x === row)
            isNextRowFirstCharDoubleWidth &&
            (thisRowLastSecondChar.getChars() || thisRowLastSecondChar.getWidth() === 0) &&
            // change background of the first wrapped cell also affects BCE
            // so we mark it as invalid to simplify the process to determine line separator
            equalBg(thisRowLastChar, nextRowFirstChar) &&
            equalBg(thisRowLastSecondChar, nextRowFirstChar)
          ) {
            isValid = true;
          }
        }

        if (!isValid) {
          // force the wrap with magic
          // insert enough character to force the wrap
          rowSeparator = '-'.repeat(this._nullCellCount + 1);
          // move back and erase next line head
          rowSeparator += '\u001b[1D\u001b[1X';

          if (this._nullCellCount > 0) {
            // do these because we filled the last several null slot, which we shouldn't
            rowSeparator += '\u001b[A';
            rowSeparator += `\u001b[${currentLine.length - this._nullCellCount}C`;
            rowSeparator += `\u001b[${this._nullCellCount}X`;
            rowSeparator += `\u001b[${currentLine.length - this._nullCellCount}D`;
            rowSeparator += '\u001b[B';
          }

          // This is content and need the be serialized even it is invisible.
          // without this, wrap will be missing from outputs.
          this._lastContentCursorRow = row + 1;
          this._lastContentCursorCol = 0;

          // force commit the cursor position
          this._lastCursorRow = row + 1;
          this._lastCursorCol = 0;
        }
      }
    }

    this._allRows[this._rowIndex] = this._currentRow;
    this._allRowSeparators[this._rowIndex++] = rowSeparator;
    this._currentRow = '';
    this._nullCellCount = 0;
  }

  private _diffStyle(cell: IBufferCell | IAttributeData, oldCell: IBufferCell): number[] {
    const sgrSeq: number[] = [];
    if (attributesEquals(cell, oldCell)) {
      return sgrSeq;
    }
    const fgChanged = !equalFg(cell, oldCell);
    const bgChanged = !equalBg(cell, oldCell);
    const flagsChanged = !equalFlags(cell, oldCell);

    if (fgChanged || bgChanged || flagsChanged) {
      if (cell.isAttributeDefault()) {
        if (!oldCell.isAttributeDefault()) {
          sgrSeq.push(0);
        }
      } else {
        if (fgChanged) {
          const color = cell.getFgColor();
          if (cell.isFgRGB()) { sgrSeq.push(38, 2, (color >>> 16) & 0xFF, (color >>> 8) & 0xFF, color & 0xFF); }
          else if (cell.isFgPalette()) {
            if (color >= 16) { sgrSeq.push(38, 5, color); }
            else { sgrSeq.push(color & 8 ? 90 + (color & 7) : 30 + (color & 7)); }
          }
          else { sgrSeq.push(39); }
        }
        if (bgChanged) {
          const color = cell.getBgColor();
          if (cell.isBgRGB()) { sgrSeq.push(48, 2, (color >>> 16) & 0xFF, (color >>> 8) & 0xFF, color & 0xFF); }
          else if (cell.isBgPalette()) {
            if (color >= 16) { sgrSeq.push(48, 5, color); }
            else { sgrSeq.push(color & 8 ? 100 + (color & 7) : 40 + (color & 7)); }
          }
          else { sgrSeq.push(49); }
        }
        if (flagsChanged) {
          if (cell.isInverse() !== oldCell.isInverse()) { sgrSeq.push(cell.isInverse() ? 7 : 27); }
          if (cell.isBold() !== oldCell.isBold()) { sgrSeq.push(cell.isBold() ? 1 : 22); }
          if (!equalUnderline(cell, oldCell)) {
            const style = cell.getUnderlineStyle();
            if (style === UnderlineStyle.NONE) {
              sgrSeq.push(24);
            } else if (style === UnderlineStyle.SINGLE && cell.isUnderlineColorDefault()) {
              sgrSeq.push(4);
            } else {
              // Use SGR 4:X format for underline styles
              sgrSeq.push('4:' + style as unknown as number);
              // Handle underline color
              if (!cell.isUnderlineColorDefault()) {
                const color = cell.getUnderlineColor();
                if (cell.isUnderlineColorRGB()) {
                  sgrSeq.push('58:2::' + ((color >>> 16) & 0xFF) + ':' + ((color >>> 8) & 0xFF) + ':' + (color & 0xFF) as unknown as number);
                } else {
                  sgrSeq.push('58:5:' + color as unknown as number);
                }
              }
            }
          } else if (cell.isUnderline() !== oldCell.isUnderline()) {
            sgrSeq.push(cell.isUnderline() ? 4 : 24);
          }
          if (cell.isOverline() !== oldCell.isOverline()) { sgrSeq.push(cell.isOverline() ? 53 : 55); }
          if (cell.isBlink() !== oldCell.isBlink()) { sgrSeq.push(cell.isBlink() ? 5 : 25); }
          if (cell.isInvisible() !== oldCell.isInvisible()) { sgrSeq.push(cell.isInvisible() ? 8 : 28); }
          if (cell.isItalic() !== oldCell.isItalic()) { sgrSeq.push(cell.isItalic() ? 3 : 23); }
          if (cell.isDim() !== oldCell.isDim()) { sgrSeq.push(cell.isDim() ? 2 : 22); }
          if (cell.isStrikethrough() !== oldCell.isStrikethrough()) { sgrSeq.push(cell.isStrikethrough() ? 9 : 29); }
        }
      }
    }

    return sgrSeq;
  }

  protected _nextCell(cell: IBufferCell, _oldCell: IBufferCell, row: number, col: number): void {
    // a width 0 cell don't need to be count because it is just a placeholder after a CJK character;
    const isPlaceHolderCell = cell.getWidth() === 0;

    if (isPlaceHolderCell) {
      return;
    }

    // this cell don't have content
    const isEmptyCell = cell.getChars() === '';

    const sgrSeq = this._diffStyle(cell, this._cursorStyle);

    // the empty cell style is only assumed to be changed when background changed, because
    // foreground is always 0.
    const styleChanged = isEmptyCell ? !equalBg(this._cursorStyle, cell) : sgrSeq.length > 0;

    /**
     *  handles style change
     */
    if (styleChanged) {
      // before update the style, we need to fill empty cell back
      if (this._nullCellCount > 0) {
        // use clear right to set background.
        if (!equalBg(this._cursorStyle, this._backgroundCell)) {
          this._currentRow += `\u001b[${this._nullCellCount}X`;
        }
        // use move right to move cursor.
        this._currentRow += `\u001b[${this._nullCellCount}C`;
        this._nullCellCount = 0;
      }

      this._lastContentCursorRow = this._lastCursorRow = row;
      this._lastContentCursorCol = this._lastCursorCol = col;

      this._currentRow += `\u001b[${sgrSeq.join(';')}m`;

      // update the last cursor style
      const line = this._buffer.getLine(row);
      if (line !== undefined) {
        line.getCell(col, this._cursorStyle);
        this._cursorStyleRow = row;
        this._cursorStyleCol = col;
      }
    }

    /**
     *  handles actual content
     */
    if (isEmptyCell) {
      this._nullCellCount += cell.getWidth();
    } else {
      if (this._nullCellCount > 0) {
        // we can just assume we have same style with previous one here
        // because style change is handled by previous stage
        // use move right when background is empty, use clear right when there is background.
        if (equalBg(this._cursorStyle, this._backgroundCell)) {
          this._currentRow += `\u001b[${this._nullCellCount}C`;
        } else {
          this._currentRow += `\u001b[${this._nullCellCount}X`;
          this._currentRow += `\u001b[${this._nullCellCount}C`;
        }
        this._nullCellCount = 0;
      }

      this._currentRow += cell.getChars();

      // update cursor
      this._lastContentCursorRow = this._lastCursorRow = row;
      this._lastContentCursorCol = this._lastCursorCol = col + cell.getWidth();
    }
  }

  protected *_serializeString(excludeFinalCursorPosition: boolean): Generator<void, string> {
    let rowEnd = this._allRows.length;

    // the fixup is only required for data without scrollback
    // because it will always be placed at last line otherwise
    if (this._buffer.length - this._firstRow <= this._terminal.rows) {
      rowEnd = this._lastContentCursorRow + 1 - this._firstRow;
      this._lastCursorCol = this._lastContentCursorCol;
      this._lastCursorRow = this._lastContentCursorRow;
    }

    // Bound final assembly too: building one giant rope in an unsliced loop
    // would move the same long task to the end of a cooperative cell scan.
    const chunks: string[] = [];
    let rowParts: string[] = [];
    let chunkLength = 0;
    for (let i = 0; i < rowEnd; i++) {
      const row = this._allRows[i];
      rowParts.push(row);
      chunkLength += row.length;
      if (i + 1 < rowEnd) {
        const separator = this._allRowSeparators[i];
        rowParts.push(separator);
        chunkLength += separator.length;
      }
      if (chunkLength >= 32 * 1024) {
        // Flatten bounded batches here. Saving `content += row` ropes and only
        // joining at the end would still synchronously flatten every cell.
        chunks.push(rowParts.join(''));
        rowParts = [];
        chunkLength = 0;
        yield;
      }
      if ((i + 1) % 32 === 0) yield;
    }
    if (rowParts.length) chunks.push(rowParts.join(''));
    let content = '';

    // restore the cursor
    if (!excludeFinalCursorPosition) {
      const realCursorRow = this._buffer.baseY + this._buffer.cursorY;
      const realCursorCol = this._buffer.cursorX;

      const cursorMoved = (realCursorRow !== this._lastCursorRow || realCursorCol !== this._lastCursorCol);

      const moveRight = (offset: number): void => {
        if (offset > 0) {
          content += `\u001b[${offset}C`;
        } else if (offset < 0) {
          content += `\u001b[${-offset}D`;
        }
      };
      const moveDown = (offset: number): void => {
        if (offset > 0) {
          content += `\u001b[${offset}B`;
        } else if (offset < 0) {
          content += `\u001b[${-offset}A`;
        }
      };

      if (cursorMoved) {
        moveDown(realCursorRow - this._lastCursorRow);
        moveRight(realCursorCol - this._lastCursorCol);
      }
    }

    // Restore the cursor's current style, see https://github.com/xtermjs/xterm.js/issues/3677
    // HACK: Internal API access since it's awkward to expose this in the API and serialize will
    // likely be the only consumer
    const curAttrData: IAttributeData = (this._terminal as any)._core._inputHandler._curAttrData;
    const sgrSeq = this._diffStyle(curAttrData, this._cursorStyle);
    if (sgrSeq.length > 0) {
      content += `\u001b[${sgrSeq.join(';')}m`;
    }

    chunks.push(content);
    // The final string allocation is required by the checkpoint transport.
    // Chunking keeps this a single linear copy, rather than a deep rope walk.
    return chunks.join('');
  }
}

function* serializeBufferByRange(
  terminal: Terminal,
  buffer: IBuffer,
  range: ISerializeRange,
  excludeFinalCursorPosition: boolean,
): Generator<void, string> {
  return yield* new StringSerializeHandler(buffer, terminal).serialize({
    start: { x: 0, y: typeof range.start === 'number' ? range.start : range.start.line },
    end: { x: terminal.cols, y: typeof range.end === 'number' ? range.end : range.end.line },
  }, excludeFinalCursorPosition);
}

function* serializeBufferByScrollback(
  terminal: Terminal,
  buffer: IBuffer,
  scrollback?: number,
): Generator<void, string> {
  const maxRows = buffer.length;
  const correctRows = scrollback === undefined ? maxRows : constrain(scrollback + terminal.rows, 0, maxRows);
  return yield* serializeBufferByRange(terminal, buffer, {
    start: maxRows - correctRows,
    end: maxRows - 1,
  }, false);
}

function serializeModesAndScrollRegion(terminal: Terminal): string {
  let content = '';
  const modes = terminal.modes;
  if (modes.applicationCursorKeysMode) content += '\x1b[?1h';
  if (modes.applicationKeypadMode) content += '\x1b[?66h';
  if (modes.bracketedPasteMode) content += '\x1b[?2004h';
  if (modes.insertMode) content += '\x1b[4h';
  if (modes.originMode) content += '\x1b[?6h';
  if (modes.reverseWraparoundMode) content += '\x1b[?45h';
  if (modes.sendFocusMode) content += '\x1b[?1004h';
  if (modes.wraparoundMode === false) content += '\x1b[?7l';
  switch (modes.mouseTrackingMode) {
    case 'x10': content += '\x1b[?9h'; break;
    case 'vt200': content += '\x1b[?1000h'; break;
    case 'drag': content += '\x1b[?1002h'; break;
    case 'any': content += '\x1b[?1003h'; break;
  }
  if (!modes.showCursor) content += '\x1b[?25l';
  // Same pinned upstream private API: the public buffer omits DECSTBM.
  const buffer = (terminal as unknown as {
    _core: { buffer: { scrollTop: number; scrollBottom: number } };
  })._core.buffer;
  if (buffer.scrollTop !== 0 || buffer.scrollBottom !== terminal.rows - 1) {
    content += `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
  }
  return content;
}

function* serializeTerminal(terminal: Terminal, options?: ISerializeOptions): Generator<void, string> {
  let content = options?.range
    ? yield* serializeBufferByRange(terminal, terminal.buffer.normal, options.range, true)
    : yield* serializeBufferByScrollback(terminal, terminal.buffer.normal, options?.scrollback);
  if (!options?.excludeAltBuffer && terminal.buffer.active.type === 'alternate') {
    const alternate = yield* serializeBufferByScrollback(terminal, terminal.buffer.alternate);
    content += `\x1b[?1049h\x1b[H${alternate}`;
  }
  if (!options?.excludeModes) content += serializeModesAndScrollRegion(terminal);
  return content;
}

export interface TerminalSerializationSchedulingOptions {
  /** Processing budget between real event-loop tasks; defaults to 4 ms. */
  budgetMs?: number;
  /** Also caps work when clocks are coarse; defaults to 32 generator steps. */
  maxStepsPerTask?: number;
  /** Injectable task scheduler and monotonic clock for regression measurements. */
  scheduleTask?: (callback: () => void) => () => void;
  now?: () => number;
}

export interface TerminalSerializationJob {
  /** A job is single-use. Repeated calls return the same promise. */
  run(signal?: AbortSignal): Promise<string>;
  /** Continue the existing scan without yielding, while the terminal remains frozen. */
  finishSync(): string;
}

/**
 * Serializes the complete upstream state machine across event-loop tasks.
 * The caller MUST hold writes, resize, reset, buffer decoration and disposal from
 * creation until completion/cancellation: a live buffer is not an immutable snapshot.
 * This intentionally does not implement the application's extra mouse encoding suffix.
 * Cancellation discards the partial scan; call finishSync BEFORE aborting on unmount.
 */
export function createTerminalSerialization(
  terminal: Terminal,
  options?: ISerializeOptions,
  scheduling: TerminalSerializationSchedulingOptions = {},
): TerminalSerializationJob {
  const iterator = serializeTerminal(terminal, options);
  const now = scheduling.now ?? (() => performance.now());
  const budgetMs = Math.max(0.1, scheduling.budgetMs ?? 4);
  const maxSteps = Math.max(1, Math.floor(scheduling.maxStepsPerTask ?? 32));
  let channel: MessageChannel | undefined;
  let scheduledCallback: (() => void) | undefined;
  let lastTimerYield = now();
  let channelTasks = 0;
  // A per-job channel avoids timer clamping and never blocks on visibility/rAF.
  const scheduleTask = scheduling.scheduleTask ?? ((callback: () => void) => {
    // Some event loops drain a busy MessagePort before checking other task
    // sources. Periodically use a timer so input/timers get a scheduling turn.
    // Interleaved channel tasks also avoid nested timer clamping in browsers.
    if (typeof MessageChannel === 'undefined' || now() - lastTimerYield >= 8 || channelTasks >= 32) {
      lastTimerYield = now();
      channelTasks = 0;
      const timer = setTimeout(callback, 0);
      return () => clearTimeout(timer);
    }
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const pending = scheduledCallback;
        scheduledCallback = undefined;
        pending?.();
      };
    }
    channelTasks++;
    scheduledCallback = callback;
    channel.port2.postMessage(null);
    return () => { scheduledCallback = undefined; };
  });
  let cancelTask: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;
  let result: string | undefined;
  let failure: unknown;
  let failed = false;
  let promise: Promise<string> | undefined;
  let resolvePromise: ((value: string) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;

  const cleanup = () => {
    cancelTask?.();
    cancelTask = undefined;
    removeAbortListener?.();
    removeAbortListener = undefined;
    channel?.port1.close();
    channel?.port2.close();
    channel = undefined;
  };
  const complete = (value: string) => {
    result = value;
    cleanup();
    resolvePromise?.(value);
  };
  const fail = (reason: unknown) => {
    failed = true;
    failure = reason;
    cleanup();
    iterator.return('');
    rejectPromise?.(reason);
  };
  const advance = () => {
    cancelTask = undefined;
    if (result !== undefined || failed) return;
    try {
      const started = now();
      for (let step = 0; step < maxSteps; step++) {
        const next = iterator.next();
        if (next.done) {
          complete(next.value);
          return;
        }
        if (now() - started >= budgetMs) break;
      }
      cancelTask = scheduleTask(advance);
    } catch (error) {
      fail(error);
    }
  };

  return {
    run(signal) {
      if (promise) return promise;
      promise = new Promise<string>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      if (failed) {
        rejectPromise!(failure);
      } else if (result !== undefined) {
        resolvePromise!(result);
      } else if (signal?.aborted) {
        fail(signal.reason ?? new DOMException('Terminal serialization aborted', 'AbortError'));
      } else {
        if (signal) {
          const onAbort = () => fail(signal.reason ?? new DOMException('Terminal serialization aborted', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
        advance();
      }
      return promise;
    },
    finishSync() {
      if (failed) throw failure;
      if (result !== undefined) return result;
      // Cancel the outstanding continuation before resuming the same generator.
      cleanup();
      try {
        while (true) {
          const next = iterator.next();
          if (next.done) {
            complete(next.value);
            return next.value;
          }
        }
      } catch (error) {
        fail(error);
        throw error;
      }
    },
  };
}
