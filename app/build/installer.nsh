; installer.nsh — NSIS custom welcome page for SigmaLink
; Shows the SmartScreen / Mark-of-the-Web workaround during installation.
; Replaces the old license-file approach (nsis.license) with an inline
; welcome page so users see the workaround text without an extra dialog.

!define MUI_WELCOMEPAGE_TITLE "Installing SigmaLink — please read"
!define MUI_WELCOMEPAGE_TEXT \
  "SigmaLink ships without an Authenticode code-signing certificate, so the$\r$\n\
   first launch of the installer (and the installed EXE) trips Microsoft$\r$\n\
   SmartScreen. After that first run, normal double-click works forever.$\r$\n$\r$\n\
   You will see a blue dialog titled:$\r$\n\
   $\r$\n\
     $\"Windows protected your PC$\"$\r$\n\
     $\"Microsoft Defender SmartScreen prevented an unrecognized app$\r$\n\
      from starting. Running this app might put your PC at risk.$\"$\r$\n$\r$\n\
   This is expected. Two ways past it — pick whichever you prefer.$\r$\n$\r$\n\
   OPTION A — Click through SmartScreen (fastest)$\r$\n\
   $\r$\n\
     1. In the $\"Windows protected your PC$\" dialog, click the small$\r$\n\
        $\"More info$\" link below the message.$\r$\n\
     2. The dialog expands and shows a $\"Run anyway$\" button at the$\r$\n\
        bottom. Click it.$\r$\n\
     Done. SigmaLink installs / launches. No more prompts.$\r$\n$\r$\n\
   OPTION B — Unblock the file before running (no SmartScreen prompt)$\r$\n\
   $\r$\n\
     Windows tags every browser download with a Mark-of-the-Web (MotW)$\r$\n\
     attribute. Stripping it tells Windows the file was vetted locally$\r$\n\
     and skips the SmartScreen check entirely.$\r$\n\
     $\r$\n\
     1. Locate the downloaded `SigmaLink-Setup-*.exe` in File Explorer.$\r$\n\
     2. Right-click the EXE → Properties.$\r$\n\
     3. At the bottom of the General tab, tick the $\"Unblock$\" checkbox.$\r$\n\
     4. Click OK. Now double-click the EXE. No SmartScreen warning appears.$\r$\n$\r$\n\
   WHY THIS HAPPENS$\r$\n\
   $\r$\n\
     Microsoft Authenticode certificates cost $200-$600/year and require$\r$\n\
     organisational identity verification. SigmaLink is currently internal-use$\r$\n\
     software while we validate the product. Once funded, we will sign the$\r$\n\
     installer and this message will go away.$\r$\n\
     $\r$\n\
     The installer is NOT malicious. The source is fully open at:$\r$\n\
     https://github.com/s1gmamale1/SigmaLink$\r$\n$\r$\n\
   Release notes:  https://github.com/s1gmamale1/SigmaLink/releases$\r$\n\
   Source:         https://github.com/s1gmamale1/SigmaLink$\r$\n\
   Issues:         https://github.com/s1gmamale1/SigmaLink/issues"
