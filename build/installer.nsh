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

; On uninstall, delete the ffmpeg builds the app downloaded on first launch
; (%APPDATA%\Velocity Studio\ffmpeg, about 120-150 MB) but keep settings and stream keys.
; Skipped when the uninstaller runs as part of an update, so ffmpeg isn't re-downloaded.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}\ffmpeg"
    !endif
    RMDir /r "$APPDATA\${APP_FILENAME}\ffmpeg"
  ${endIf}
!macroend
