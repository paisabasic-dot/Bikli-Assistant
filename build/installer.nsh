; =============================================================================
; BIKLI — NSIS installer hooks
; -----------------------------------------------------------------------------
; Force-close any running BIKLI and bikli-agent processes before install or
; uninstall so files are not locked and can be replaced/removed.
;
; electron-builder supports these custom macros:
;   customInit      — runs at the start of .onInit
;   un.customInit   — runs at the start of un.onInit
; =============================================================================

!macro customInit
  nsExec::ExecToStack /OEM "taskkill /F /IM BIKLI.exe 2>NUL"
  nsExec::ExecToStack /OEM "taskkill /F /IM bikli-agent.exe 2>NUL"
  nsExec::ExecToStack /OEM "taskkill /F /IM electron.exe 2>NUL"
  Sleep 500
!macroend

!macro un.customInit
  nsExec::ExecToStack /OEM "taskkill /F /IM BIKLI.exe 2>NUL"
  nsExec::ExecToStack /OEM "taskkill /F /IM bikli-agent.exe 2>NUL"
  Sleep 500
!macroend
