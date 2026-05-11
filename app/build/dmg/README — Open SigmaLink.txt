SigmaLink — How to open it on macOS the first time
====================================================

SigmaLink is signed with an ad-hoc signature, not with an Apple Developer
ID. macOS Gatekeeper does not trust ad-hoc signatures on quarantined
downloads, so the first launch needs one extra step. After that, normal
double-click works forever.

Pick whichever option is more comfortable:


OPTION A — Terminal (fastest, two commands)
--------------------------------------------

  Open Terminal.app and run:

    xattr -cr /Applications/SigmaLink.app
    open /Applications/SigmaLink.app

  Done. SigmaLink launches. No more prompts.


OPTION B — System Settings (no Terminal needed)
------------------------------------------------

  1. Try to open SigmaLink (double-click in /Applications). You will see:

       "SigmaLink Not Opened — Apple could not verify..."

     Click "Done" — DO NOT click "Move to Trash".

  2. Open  > System Settings → Privacy & Security.

  3. Scroll DOWN to the "Security" section near the bottom.

  4. You will see a line that reads:
       "SigmaLink" was blocked to protect your Mac.

     Click the "Open Anyway" button next to it.

  5. macOS will ask you to authenticate (Touch ID or your password).

  6. The original warning dialog will re-appear. Click "Open".

  Done. SigmaLink launches. The exception is remembered.


WHY THIS HAPPENS
================

Apple's notarisation service requires a paid Apple Developer Program
membership ($99/year per developer). SigmaLink is currently shipping
without that membership while we validate the product. Once the project
is funded, we will add notarisation and this README will go away — the
DMG will become a single double-click install like a signed App Store
app.

The bundle is NOT damaged, NOT malicious, and the source is fully open
at https://github.com/s1gmamale1/SigmaLink. The Gatekeeper rejection is
purely about the missing notarisation ticket, not about the integrity
of the code.


KEEP READING / ASK FOR HELP
===========================

  Release notes:  https://github.com/s1gmamale1/SigmaLink/releases
  Source:         https://github.com/s1gmamale1/SigmaLink
  Issues:         https://github.com/s1gmamale1/SigmaLink/issues
