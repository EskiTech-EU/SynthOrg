; Tries hooks.nsh by itself: a program that only runs the uninstaller's hook, against folders made for the purpose
; and a registry key of its own. Built and run by scripts/check-uninstall-hook.js; never part of the installer.
;   HOOK_ROOT    a folder with install\ (the app's folder) and editor\ (the editor's data) inside
;   HOOK_CHECK   1 when "delete the application data" is ticked
;   HOOK_UPDATE  1 when the uninstaller runs for an update
Unicode true
!include LogicLib.nsh
!define SYNTHORG_REG_KEY "Software\SynthOrgHookCheck"
!define SYNTHORG_DISTRO "synthorg-hook-check-not-there"
!define SYNTHORG_EDITOR_DIR "$%HOOK_ROOT%\editor"
!define SYNTHORG_PROFILE_DIR "$%HOOK_ROOT%\profile"
Var DeleteAppDataCheckboxState
Var UpdateMode
!include "hooks.nsh"
Name "SynthOrg hook check"
OutFile "$%HOOK_OUT%"
RequestExecutionLevel user
SilentInstall silent
Section
  StrCpy $INSTDIR "$%HOOK_ROOT%\install"
  StrCpy $DeleteAppDataCheckboxState "$%HOOK_CHECK%"
  StrCpy $UpdateMode "$%HOOK_UPDATE%"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
