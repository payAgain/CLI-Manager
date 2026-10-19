import { Input } from "@/components/ui/input";
import { ArrowDown, ArrowUp, Pencil, Search } from "lucide-react";
import { useMemo, useRef, useState, type RefObject } from "react";
import { useI18n } from "../../lib/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

interface MetaEditorProps {
  aliasDraft: string;
  tagsDraft: string;
  tagSuggestions: string[];
  sessionQuery: string;
  sessionSearchRef: RefObject<HTMLInputElement | null>;
  matchCursor: number;
  matchCount: number;
  onAliasDraftChange: (value: string) => void;
  onTagsDraftChange: (value: string) => void;
  onSessionQueryChange: (value: string) => void;
  onSaveMeta: () => void;
  onJumpPrev: () => void;
  onJumpNext: () => void;
}

export function MetaEditor({
  aliasDraft,
  tagsDraft,
  tagSuggestions,
  sessionQuery,
  sessionSearchRef,
  matchCursor,
  matchCount,
  onAliasDraftChange,
  onTagsDraftChange,
  onSessionQueryChange,
  onSaveMeta,
  onJumpPrev,
  onJumpNext,
}: MetaEditorProps) {
  const { t } = useI18n();
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const selectedTags = useMemo(
    () => new Set(tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean)),
    [tagsDraft]
  );
  const tagDraftParts = tagsDraft.split(",");
  const activeTagQuery = (tagDraftParts[tagDraftParts.length - 1] ?? "").trim().toLowerCase();
  const visibleTagSuggestions = useMemo(
    () =>
      tagSuggestions
        .filter((tag) => !selectedTags.has(tag))
        .filter((tag) => !activeTagQuery || tag.toLowerCase().includes(activeTagQuery))
        .slice(0, 8),
    [activeTagQuery, selectedTags, tagSuggestions]
  );
  const showTagPicker = tagPickerOpen && visibleTagSuggestions.length > 0;

  const applyTagSuggestion = (tag: string) => {
    const previousTags = tagsDraft
      .split(",")
      .slice(0, -1)
      .map((item) => item.trim())
      .filter(Boolean);
    onTagsDraftChange([...previousTags, tag].join(", "));
    tagInputRef.current?.focus();
    setTagPickerOpen(false);
  };

  return (
    <div className="ui-history-detail-controls">
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact ui-focus-ring">
            <Pencil size={12} />
            {t("history.meta.edit")}
          </button>
        </PopoverTrigger>
        <PopoverContent className="ui-history-meta-popover" data-history-popover="metadata" aria-label={t("history.meta.edit")}>
          <label className="ui-history-meta-field">
            <span>{t("history.meta.alias")}</span>
            <Input
              value={aliasDraft}
              onChange={(e) => onAliasDraftChange(e.target.value)}
              aria-label={t("history.meta.alias")}
              placeholder={t("history.meta.aliasPlaceholder")}
              className="h-7 px-2 text-xs"
            />
          </label>
          <div className="ui-history-meta-field">
            <span>{t("history.meta.tags")}</span>
            <div className="relative min-w-0">
              <Input
                ref={tagInputRef}
                value={tagsDraft}
                onChange={(e) => {
                  onTagsDraftChange(e.target.value);
                  setTagPickerOpen(true);
                }}
                onFocus={() => setTagPickerOpen(true)}
                onBlur={(event) => {
                  if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) setTagPickerOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setTagPickerOpen(false);
                }}
                aria-label={t("history.meta.tags")}
                placeholder={t("history.meta.tagsPlaceholder")}
                className="h-7 px-2 text-xs"
              />
              {showTagPicker && (
                <div className="ui-history-tag-suggestions">
                  {visibleTagSuggestions.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyTagSuggestion(tag)}
                      className="block w-full rounded px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-tertiary focus:bg-bg-tertiary focus:outline-none"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <button type="button" onClick={onSaveMeta} className="ui-btn ui-btn-primary ui-focus-ring h-7 text-xs">
            {t("history.meta.save")}
          </button>
        </PopoverContent>
      </Popover>

      <div className="ui-input ui-history-session-search">
        <Search size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
        <input
          ref={sessionSearchRef}
          value={sessionQuery}
          onChange={(e) => onSessionQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && matchCount > 0) {
              e.preventDefault();
              if (e.shiftKey) onJumpPrev();
              else onJumpNext();
            }
          }}
          aria-label={t("history.meta.search")}
          placeholder={t("history.meta.search")}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        {sessionQuery.trim() && (
          <>
            <span className="shrink-0 text-[10px] text-text-muted" aria-live="polite">
              {matchCount === 0 ? "0" : `${Math.min(matchCursor + 1, matchCount)}/${matchCount}`}
            </span>
            <button type="button" onClick={onJumpPrev} disabled={matchCount === 0} aria-label={t("history.meta.prevMatch")} className="ui-flat-action ui-focus-ring ui-history-icon-button" title={t("history.meta.prevMatch")}>
              <ArrowUp size={12} aria-hidden="true" />
            </button>
            <button type="button" onClick={onJumpNext} disabled={matchCount === 0} aria-label={t("history.meta.nextMatch")} className="ui-flat-action ui-focus-ring ui-history-icon-button" title={t("history.meta.nextMatch")}>
              <ArrowDown size={12} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
