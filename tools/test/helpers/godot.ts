/** How the fake one-process checker run does not end cleanly: shell commands it runs before the first script, between scripts, after the last, and its exit code. */
export interface OneProcessFault {
  before?: string;
  between?: string;
  after?: string;
  code?: number;
}

/**
 * A fake Godot body for both type check modes: per file (`--check-only --script <file>`) it runs `body`; for the one
 * process checker (`-s <checker> -- <list>`) it runs `body` for each listed script with its output on stderr and puts
 * the checker's markers around it, a script being valid when `body` exits 0. There `body` sees `ONE_PROCESS=1`.
 * `fault` makes that run not end cleanly.
 */
export function bothModes(body: string, fault: OneProcessFault = {}): string {
  return `last=""; for a in "$@"; do last="$a"; done
case "$*" in
  *" -s "*)
    i=0
    ${fault.before ?? ':'}
    while IFS= read -r p || [ -n "$p" ]; do
      [ $i -gt 0 ] && { ${fault.between ?? ':'}; }
      echo "OGW_CHECK_BEGIN $i" >&2
      ( set -- --check-only --script "$p"; ONE_PROCESS=1; ${body}
      ) 1>&2
      if [ $? -eq 0 ]; then v=1; else v=0; fi
      echo "OGW_CHECK_END $i $v" >&2
      i=$((i+1))
    done < "$last"
    ${fault.after ?? ':'}
    exit ${String(fault.code ?? 0)};;
esac
${body}`;
}
