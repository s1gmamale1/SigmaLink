SigmaLink — How to open it on Windows the first time
=====================================================

SigmaLink ships without an Authenticode code-signing certificate, so the
first launch of the installer (and the installed EXE) trips Microsoft
SmartScreen. After that first run, normal double-click works forever.

You will see a blue dialog titled:

    "Windows protected your PC"
    "Microsoft Defender SmartScreen prevented an unrecognized app
     from starting. Running this app might put your PC at risk."

This is expected. Two ways past it — pick whichever you prefer.


OPTION A — Click through SmartScreen (fastest)
----------------------------------------------

  1. In the "Windows protected your PC" dialog, click the small
     "More info" link below the message.

  2. The dialog expands and shows a "Run anyway" button at the
     bottom. Click it.

  Done. SigmaLink installs / launches. No more prompts.


OPTION B — Unblock the file before running (no SmartScreen prompt)
-------------------------------------------------------------------

  Windows tags every browser download with a Mark-of-the-Web (MotW)
  attribute. Stripping it tells Windows the file was vetted locally
  and skips the SmartScreen check entirely.

  1. Locate the downloaded `SigmaLink-Setup-*.exe` in File Explorer.

  2. Right-click the EXE → Properties.

  3. At the bottom of the General tab, find the "Security:" line:
       "This file came from another computer and might be blocked
        to help protect this computer."

  4. Tick the "Unblock" checkbox next to it.

  5. Click OK.

  Now double-click the EXE. No SmartScreen warning appears.


WHY THIS HAPPENS
================

Microsoft Authenticode certificates (especially EV certs that build
SmartScreen reputation quickly) cost $200-$600/year and require an
organisational identity verification process. SigmaLink is currently
internal-use software while we validate the product, and the developer
has not yet purchased an Authenticode certificate. Once the project is
funded, we will sign the installer and this README will go away — the
EXE will install with a single double-click like any signed app.

The installer is NOT malicious. The source is fully open at
https://github.com/s1gmamale1/SigmaLink and the SmartScreen prompt is
purely about the missing signature, not the integrity of the code.


KEEP READING / ASK FOR HELP
===========================

  Release notes:  https://github.com/s1gmamale1/SigmaLink/releases
  Source:         https://github.com/s1gmamale1/SigmaLink
  Issues:         https://github.com/s1gmamale1/SigmaLink/issues
