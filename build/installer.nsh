; Custom NSIS hooks, picked up automatically by electron-builder (build/installer.nsh).
;
; Launch Velocity Studio as soon as installation finishes. The stock one-click
; "run after finish" step goes through Explorer (ShellExecute as user), which can
; silently do nothing; starting the exe directly is reliable for a per-user install.
; Silent installs (e.g. scripted / auto-update) are left alone.
!macro customInstall
  ${ifNot} ${Silent}
    HideWindow
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  ${endIf}
!macroend
