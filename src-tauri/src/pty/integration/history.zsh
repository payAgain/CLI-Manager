# Only commands accepted by the interactive shell reach preexec. Child programs
# (Agent prompts, sudo/password entry, editors) never pass through this hook.
[[ -o interactive && $CLI_MANAGER_COMMAND_HISTORY == 1 ]] || return 0
autoload -Uz add-zsh-hook
typeset -gi __cli_manager_history_counter=0
__cli_manager_history_preexec() {
  [[ -n $1 && $1 != [[:space:]]* && ${#1} -le 4096 ]] || return 0
  local encoded
  encoded=$(print -rn -- "$1" | command base64 | command tr -d '\r\n') || return 0
  (( ++__cli_manager_history_counter ))
  printf '\033]777;cli-manager-history;%s;%s-%s;%s\007' "$CLI_MANAGER_TAB_ID" "$$" "$__cli_manager_history_counter" "$encoded"
  return 0
}
add-zsh-hook -d preexec __cli_manager_history_preexec 2>/dev/null
add-zsh-hook preexec __cli_manager_history_preexec
