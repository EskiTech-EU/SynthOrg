; SynthOrg: what the uninstaller removes, besides the program.
;
; What SynthOrg keeps is of two kinds (server/memory.js):
;   - the memory: what is the user's own — the database, the chats and their files, the artifacts of the projects,
;     the copy of the projects that live in the pods, the editor's settings. Beside the app, or in a place the user
;     chose;
;   - the engine: what only makes the app run and can be had again — the models, the packages, the base images, the
;     window's profile, the disk of the pods.
;
; An uninstall always removes the engine: nothing of the app is left around that the user did not ask to keep. The
; memory stays, unless "delete the application data" is ticked — the installer's own box, unticked unless the user
; ticks it. The disk of the pods is the one thing of the engine that can hold what is nowhere else: it goes with the
; engine only when the app said the pods' projects are copied into the memory, and otherwise with the memory.
;
; The memory kept elsewhere is removed only as its own folder, and only if it carries the mark the app put in it:
; never a folder the user merely picked, whatever the registry says.
; Never on an update, which runs the uninstaller of the version before.
;
; The names can be given from outside: that is how this is tried against folders made for the purpose
; (src-tauri/nsis/hooks-check.nsi) and not against what is really installed.
!ifndef SYNTHORG_REG_KEY
  !define SYNTHORG_REG_KEY "Software\SynthOrg"
!endif
!ifndef SYNTHORG_DISTRO
  !define SYNTHORG_DISTRO "synthorg-pods"
!endif
!ifndef SYNTHORG_EDITOR_DIR
  !define SYNTHORG_EDITOR_DIR "$APPDATA\SynthOrg"
!endif
!ifndef SYNTHORG_PROFILE_DIR
  !define SYNTHORG_PROFILE_DIR "$LOCALAPPDATA\org.synthorg.orchestrator"
!endif

!macro SYNTHORG_REMOVE_ENGINE_ITEM NAME
  ${If} ${FileExists} "$INSTDIR\data\${NAME}\*.*"
    RMDir /r "$INSTDIR\data\${NAME}"
  ${EndIf}
  Delete "$INSTDIR\data\${NAME}"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; The engine, whatever is ticked.
    !insertmacro SYNTHORG_REMOVE_ENGINE_ITEM "models"
    !insertmacro SYNTHORG_REMOVE_ENGINE_ITEM "packages"
    !insertmacro SYNTHORG_REMOVE_ENGINE_ITEM "images"
    !insertmacro SYNTHORG_REMOVE_ENGINE_ITEM "git-none"
    !insertmacro SYNTHORG_REMOVE_ENGINE_ITEM "seccomp.json"
    ${If} ${FileExists} "${SYNTHORG_PROFILE_DIR}\*.*"
      RMDir /r "${SYNTHORG_PROFILE_DIR}"
    ${EndIf}
    ; What an earlier version kept of the editor outside the memory.
    ${If} ${FileExists} "${SYNTHORG_EDITOR_DIR}\Code\*.*"
      RMDir /r "${SYNTHORG_EDITOR_DIR}\Code"
    ${EndIf}
    RMDir "${SYNTHORG_EDITOR_DIR}"
    ; The disk of the pods: with the engine when its projects are also in the memory, otherwise with the memory.
    ; Nothing happens when it is not there.
    ReadRegStr $1 HKCU "${SYNTHORG_REG_KEY}" "PodsCopied"
    ${If} $1 == "1"
    ${OrIf} $DeleteAppDataCheckboxState = 1
      nsExec::Exec 'wsl.exe --unregister ${SYNTHORG_DISTRO}'
      Pop $1
      ; The folder the app made for it (its note, and what WSL may leave).
      !insertmacro SYNTHORG_REMOVE_ENGINE_ITEM "runtime"
    ${EndIf}

    ${If} $DeleteAppDataCheckboxState = 1
      ; The memory kept elsewhere: its own marked folder, and nothing around it.
      ReadRegStr $0 HKCU "${SYNTHORG_REG_KEY}" "MemoryDir"
      ${If} $0 != ""
      ${AndIf} ${FileExists} "$0\.synthorg-memoria"
        RMDir /r "$0"
      ${EndIf}
      ; What is beside the app.
      ${If} ${FileExists} "$INSTDIR\data\*.*"
        RMDir /r "$INSTDIR\data"
      ${EndIf}
      DeleteRegKey HKCU "${SYNTHORG_REG_KEY}"
    ${EndIf}
    RMDir "$INSTDIR\data"
    RMDir "$INSTDIR"
  ${EndIf}
!macroend
