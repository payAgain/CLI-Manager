# Observe changes to the shell's accepted history at the next prompt. Starting
# with its current history id avoids importing commands from other terminals.
if [[ $- == *i* && ${CLI_MANAGER_COMMAND_HISTORY:-} == 1 ]]; then
  __cli_manager_history_counter=0
  __cli_manager_history_last=$(HISTTIMEFORMAT= builtin history 1)
  __cli_manager_history_prompt() {
    local previous_status=$? record command_line encoded
    record=$(HISTTIMEFORMAT= builtin history 1)
    if [[ -n $record && $record != "$__cli_manager_history_last" ]]; then
      __cli_manager_history_last=$record
      # bash history prints whitespace, the numeric id, then two separator spaces.
      record="${record#"${record%%[![:space:]]*}"}"
      command_line="${record#*  }"
      if [[ $command_line != [[:space:]]* && ${#command_line} -le 4096 && -n $command_line ]]; then
        encoded=$(printf '%s' "$command_line" | command base64 | command tr -d '\r\n')
        __cli_manager_history_counter=$((__cli_manager_history_counter + 1))
        printf '\033]777;cli-manager-history;%s;%s-%s;%s\007' "$CLI_MANAGER_TAB_ID" "$$" "$__cli_manager_history_counter" "$encoded"
      fi
    fi
    return "$previous_status"
  }
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
    PROMPT_COMMAND+=(__cli_manager_history_prompt)
  else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__cli_manager_history_prompt"
  fi
fi
