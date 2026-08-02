import { fail } from "./errors.mjs";

const POSIX_HOOK = `# skillsenv shell hook: activation is cache-only and trust-gated
_skillsenv_auto_activate() {
  if [ "\${_SKILLSENV_LAST_PWD-}" = "$PWD" ]; then
    return
  fi
  _SKILLSENV_LAST_PWD="$PWD"
  command skillsenv activate --quiet >/dev/null 2>&1 || true
}
`;

export function shellInit(shell) {
  if (shell === "bash") {
    return `${POSIX_HOOK}
case ";\${PROMPT_COMMAND-};" in
  *";_skillsenv_auto_activate;"*) ;;
  *) PROMPT_COMMAND="_skillsenv_auto_activate\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
_skillsenv_auto_activate
`;
  }
  if (shell === "zsh") {
    return `${POSIX_HOOK}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _skillsenv_auto_activate
_skillsenv_auto_activate
`;
  }
  if (shell === "fish") {
    return `# skillsenv shell hook: activation is cache-only and trust-gated
function __skillsenv_auto_activate --on-variable PWD
    command skillsenv activate --quiet >/dev/null 2>/dev/null; or true
end
__skillsenv_auto_activate
`;
  }
  fail(`Unsupported shell: ${shell}; expected bash, zsh, or fish`);
}
