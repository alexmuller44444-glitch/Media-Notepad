; Extra NSIS steps for Media Notepad.
;
; Recreate the desktop and Start Menu shortcuts with an explicit icon file
; shipped next to the executable. Pointing the shortcut at its own .ico (rather
; than the EXE's embedded icon) guarantees Windows shows the yellow notepad
; icon even when upgrading over an install that cached the old blue icon.

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$INSTDIR\icons\icon.ico"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icons\icon.ico" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

    !if "${STARTMENUFOLDER}" != ""
      CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icons\icon.ico" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    !else
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\icons\icon.ico" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !endif
  ${EndIf}
!macroend
