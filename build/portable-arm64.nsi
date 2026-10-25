Unicode true
!define MUI_ICON "${ICON_FILE}"
!include "MUI2.nsh"
Name "Piku Down ${APP_VERSION} ARM64"
OutFile "${OUTPUT_FILE}"
Icon "${ICON_FILE}"
RequestExecutionLevel user
SetCompressor lzma
ShowInstDetails show
AutoCloseWindow true
BrandingText "Piku Down ${APP_VERSION}"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
VIProductVersion "${APP_VERSION_NUM}"
VIAddVersionKey /LANG=2052 "ProductName" "Piku Down"
VIAddVersionKey /LANG=2052 "FileDescription" "Piku Down ARM64 Portable"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION_NUM}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Piku Down"

Section
  InitPluginsDir
  StrCpy $INSTDIR "$PLUGINSDIR\PikuDown"
  SetOutPath "$INSTDIR"
  DetailPrint "正在解压 Piku Down，首次启动可能需要一些时间…"
  ClearErrors
  File /r "${APP_DIR}\*.*"
  IfErrors extraction_failed
  DetailPrint "正在启动 ARM64 应用…"
  ClearErrors
  ExecWait '"$INSTDIR\Piku Down.exe"' $0
  IfErrors launch_failed
  StrCmp $0 "0" done
  MessageBox MB_OK|MB_ICONEXCLAMATION "应用已退出，退出代码：$0。此版本需要 Windows ARM64 系统。"
  Goto done
launch_failed:
  MessageBox MB_OK|MB_ICONSTOP "无法启动 Piku Down。请确认使用 Windows ARM64 系统，并检查安全软件的拦截记录。"
  SetErrorLevel 1
  Goto cleanup
extraction_failed:
  MessageBox MB_OK|MB_ICONSTOP "解压失败。请检查临时目录的可用空间与写入权限。"
  SetErrorLevel 1
  Goto cleanup
done:
  SetErrorLevel $0
cleanup:
  SetOutPath "$TEMP"
  ; Only remove the private directory allocated to this launcher instance.
  RMDir /r "$INSTDIR"
SectionEnd
